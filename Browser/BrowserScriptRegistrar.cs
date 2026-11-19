using Jellyfin.Plugin.SeerrIntegration.Configuration;
using MediaBrowser.Model.Plugins;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SeerrIntegration.Browser;

/// <summary>
/// What the last attempt to register the page's loader with JavaScript Injector produced.
/// </summary>
public enum LoaderRegistrationState
{
    /// <summary>Nothing has been attempted yet.</summary>
    Pending,

    /// <summary>The loader is registered; browsers pick the page up on their next refresh.</summary>
    Registered,

    /// <summary>The Requests page is switched off in this plugin's settings.</summary>
    Disabled,

    /// <summary>JavaScript Injector is not installed or not loaded.</summary>
    InjectorMissing,

    /// <summary>JavaScript Injector is loaded but refused or failed the registration.</summary>
    Failed
}

/// <summary>
/// Keeps the Requests page's loader registered with JavaScript Injector while the page is
/// switched on.
/// </summary>
/// <remarks>
/// Registration happens at startup and when the setting changes, never per request. The
/// registered script is only a few lines: it loads the page's real code from this plugin's
/// own endpoint, so a plugin upgrade replaces the page without touching the injector's
/// configuration again. Shutdown leaves the registration in place so the injector's
/// configuration is not rewritten on every restart.
/// </remarks>
public sealed class BrowserScriptRegistrar : IHostedService
{
    internal const string BootstrapResourceName = "Jellyfin.Plugin.SeerrIntegration.Browser.bootstrap.js";
    internal const string ScriptName = "Seerr Integration Requests page";
    internal const string VersionToken = "__SEERR_INTEGRATION_VERSION__";

    private readonly JavaScriptInjectorBridge _bridge;
    private readonly Func<string> _scriptLoader;
    private readonly ILogger<BrowserScriptRegistrar> _logger;
    private readonly object _lock = new();
    private Plugin? _plugin;
    private bool _registered;

    /// <summary>
    /// Initializes a new instance of the <see cref="BrowserScriptRegistrar"/> class.
    /// </summary>
    /// <param name="logger">Logger.</param>
    public BrowserScriptRegistrar(ILogger<BrowserScriptRegistrar> logger)
        : this(new JavaScriptInjectorBridge(), LoadScript, logger)
    {
    }

    internal BrowserScriptRegistrar(
        JavaScriptInjectorBridge bridge,
        Func<string> scriptLoader,
        ILogger<BrowserScriptRegistrar> logger)
    {
        _bridge = bridge ?? throw new ArgumentNullException(nameof(bridge));
        _scriptLoader = scriptLoader ?? throw new ArgumentNullException(nameof(scriptLoader));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Gets the script's ID in JavaScript Injector. Stable across restarts, so registering again
    /// replaces the stored script instead of adding a copy.
    /// </summary>
    internal static string ScriptId { get; } = Plugin.PluginId.ToString("D") + "-requests-page";

    /// <summary>
    /// Gets the outcome of the most recent registration attempt.
    /// </summary>
    public LoaderRegistrationState State { get; private set; } = LoaderRegistrationState.Pending;

    /// <summary>
    /// Gets why the most recent attempt failed, when it did.
    /// </summary>
    public string? Detail { get; private set; }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _plugin = Plugin.Instance;
        if (_plugin == null)
        {
            return Task.CompletedTask;
        }

        _plugin.ConfigurationChanged += OnConfigurationChanged;
        Apply(_plugin.Configuration);
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (_plugin != null)
        {
            _plugin.ConfigurationChanged -= OnConfigurationChanged;
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// Registers the loader when the page is on and not yet registered, and removes it when the
    /// page is switched off. A failed registration is retried on the next configuration change.
    /// </summary>
    /// <param name="config">The current configuration.</param>
    internal void Apply(PluginConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(config);

        lock (_lock)
        {
            if (!config.Enabled)
            {
                if (_registered)
                {
                    _bridge.Unregister(ScriptId);
                    _registered = false;
                    _logger.LogInformation("Requests page switched off; removed its loader from JavaScript Injector");
                }

                State = LoaderRegistrationState.Disabled;
                Detail = null;
                return;
            }

            if (_registered)
            {
                return;
            }

            // Registering at every startup also replaces the stored loader after a plugin upgrade,
            // which is what moves browsers onto the new version's page.
            var result = Register();
            switch (result.Status)
            {
                case InjectorRegistrationStatus.Registered:
                    _registered = true;
                    State = LoaderRegistrationState.Registered;
                    Detail = null;
                    _logger.LogInformation(
                        "JavaScript Injector detected; registered the Requests page loader ({ScriptId})",
                        ScriptId);
                    break;
                case InjectorRegistrationStatus.NotInstalled:
                    State = LoaderRegistrationState.InjectorMissing;
                    Detail = null;
                    _logger.LogWarning(
                        "The Jellyfin JavaScript Injector plugin was not found, so Jellyfin Web does not show the Requests page. Install JavaScript Injector and restart Jellyfin.");
                    break;
                default:
                    State = LoaderRegistrationState.Failed;
                    Detail = result.Detail;
                    _logger.LogWarning(
                        "Registering the Requests page loader with JavaScript Injector failed ({Reason}), so Jellyfin Web does not show the Requests page.",
                        result.Detail);
                    break;
            }
        }
    }

    internal static string LoadScript()
    {
        using var stream = typeof(BrowserScriptRegistrar).Assembly.GetManifestResourceStream(BootstrapResourceName)
            ?? throw new InvalidOperationException("Embedded resource " + BootstrapResourceName + " is missing");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    /// <summary>
    /// Gets the version the loader asks for, which is also what busts the browser cache when
    /// the plugin is upgraded.
    /// </summary>
    /// <returns>The plugin version.</returns>
    internal static string GetVersion()
    {
        return Plugin.Instance?.Version.ToString()
            ?? typeof(Plugin).Assembly.GetName().Version?.ToString()
            ?? "0.0.0.0";
    }

    private InjectorRegistrationResult Register()
    {
        string script;
        try
        {
            script = _scriptLoader().Replace(VersionToken, GetVersion(), StringComparison.Ordinal);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return InjectorRegistrationResult.Failed("the embedded loader script could not be read: " + ex.Message);
        }

        return _bridge.Register(new InjectorScript(
            ScriptId,
            ScriptName,
            script,
            RequiresAuthentication: true,
            Plugin.PluginId.ToString("D"),
            Plugin.Instance?.Name ?? "Seerr Integration",
            GetVersion()));
    }

    private void OnConfigurationChanged(object? sender, BasePluginConfiguration configuration)
    {
        // Saving the settings page must never fail because the injector misbehaved.
        try
        {
            if (configuration is PluginConfiguration config)
            {
                Apply(config);
            }
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _logger.LogError(ex, "Error updating the Requests page loader registration");
        }
    }
}
