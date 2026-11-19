using Jellyfin.Plugin.SeerrIntegration.Browser;
using Jellyfin.Plugin.SeerrIntegration.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.SeerrIntegration;

/// <summary>
/// Main Seerr Integration plugin entry point.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Plugin unique identifier.
    /// </summary>
    public static readonly Guid PluginId = Guid.Parse("c937e280-0ac7-4250-a620-8c5892e628fe");

    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">Jellyfin application paths.</param>
    /// <param name="xmlSerializer">Jellyfin XML serializer.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <inheritdoc />
    public override string Name => "Seerr Integration";

    /// <inheritdoc />
    public override Guid Id => PluginId;

    /// <inheritdoc />
    public override string Description =>
        "Adds a Requests page to Jellyfin Web for discovering and requesting movies and series in Seerr. Every request is made as the signed-in Jellyfin user through Seerr Proxy.";

    /// <summary>
    /// Gets the active plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
            }
        };
    }

    /// <inheritdoc />
    public override void OnUninstalling()
    {
        // JavaScript Injector keeps plugin scripts in its own configuration and never prunes
        // them, so an uninstalled plugin would otherwise leave its loader behind for good.
        new JavaScriptInjectorBridge().Unregister(BrowserScriptRegistrar.ScriptId);
        base.OnUninstalling();
    }
}
