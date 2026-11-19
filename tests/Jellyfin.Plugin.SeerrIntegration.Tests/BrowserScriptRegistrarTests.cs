using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.SeerrIntegration.Browser;
using Jellyfin.Plugin.SeerrIntegration.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SeerrIntegration.Tests;

/// <remarks>
/// The registrar reads the plugin version through <c>Plugin.Instance</c>, so it shares the
/// <c>PluginInstance</c> collection with the other classes that set it.
/// </remarks>
[Collection("PluginInstance")]
public class BrowserScriptRegistrarTests
{
    [Fact]
    public void ScriptId_IsStableAndDerivedFromThePluginGuid()
    {
        Assert.Equal("c937e280-0ac7-4250-a620-8c5892e628fe-requests-page", BrowserScriptRegistrar.ScriptId);
    }

    [Fact]
    public void Apply_RegistersOnceWhileThePageStaysOn()
    {
        var injector = new CountingInjector();
        var registrar = injector.CreateRegistrar(new ListLogger<BrowserScriptRegistrar>());
        var config = new PluginConfiguration();

        registrar.Apply(config);
        registrar.Apply(config);

        Assert.Equal(1, injector.RegisterCalls);
        Assert.Equal(LoaderRegistrationState.Registered, registrar.State);
        using var payload = JsonDocument.Parse(injector.LastPayloadJson!);
        Assert.Equal(BrowserScriptRegistrar.ScriptId, payload.RootElement.GetProperty("id").GetString());
        Assert.True(payload.RootElement.GetProperty("requiresAuthentication").GetBoolean());
        Assert.True(payload.RootElement.GetProperty("enabled").GetBoolean());
        Assert.Equal(Plugin.PluginId.ToString("D"), payload.RootElement.GetProperty("pluginId").GetString());
    }

    [Fact]
    public void Apply_StampsTheLoaderWithThePluginVersion()
    {
        var injector = new CountingInjector();
        var registrar = new BrowserScriptRegistrar(
            new JavaScriptInjectorBridge(() => typeof(CountingInjector.Interface)),
            () => "load('" + BrowserScriptRegistrar.VersionToken + "');",
            new ListLogger<BrowserScriptRegistrar>());

        registrar.Apply(new PluginConfiguration());

        using var payload = JsonDocument.Parse(injector.LastPayloadJson!);
        var script = payload.RootElement.GetProperty("script").GetString()!;
        Assert.DoesNotContain(BrowserScriptRegistrar.VersionToken, script, StringComparison.Ordinal);
        Assert.Equal("load('" + BrowserScriptRegistrar.GetVersion() + "');", script);
        Assert.Equal(BrowserScriptRegistrar.GetVersion(), payload.RootElement.GetProperty("pluginVersion").GetString());
    }

    [Fact]
    public void Apply_LeavesTheInjectorAloneWhileThePageIsOff()
    {
        var injector = new CountingInjector();
        var registrar = injector.CreateRegistrar(new ListLogger<BrowserScriptRegistrar>());

        registrar.Apply(new PluginConfiguration { Enabled = false });

        Assert.Equal(0, injector.RegisterCalls);
        Assert.Equal(0, injector.UnregisterCalls);
        Assert.Equal(LoaderRegistrationState.Disabled, registrar.State);
    }

    [Fact]
    public void Apply_RemovesTheLoaderWhenThePageIsSwitchedOff()
    {
        var injector = new CountingInjector();
        var registrar = injector.CreateRegistrar(new ListLogger<BrowserScriptRegistrar>());

        registrar.Apply(new PluginConfiguration());
        registrar.Apply(new PluginConfiguration { Enabled = false });

        Assert.Equal(1, injector.UnregisterCalls);
        Assert.Equal(BrowserScriptRegistrar.ScriptId, injector.LastUnregisteredId);
        Assert.Equal(LoaderRegistrationState.Disabled, registrar.State);
    }

    [Fact]
    public void Apply_RegistersAgainWhenThePageIsSwitchedBackOn()
    {
        var injector = new CountingInjector();
        var registrar = injector.CreateRegistrar(new ListLogger<BrowserScriptRegistrar>());

        registrar.Apply(new PluginConfiguration());
        registrar.Apply(new PluginConfiguration { Enabled = false });
        registrar.Apply(new PluginConfiguration());

        Assert.Equal(2, injector.RegisterCalls);
        Assert.Equal(LoaderRegistrationState.Registered, registrar.State);
    }

    [Fact]
    public void Apply_WarnsWhenTheInjectorIsMissingAndTriesAgainOnTheNextChange()
    {
        var logger = new ListLogger<BrowserScriptRegistrar>();
        var locateCalls = 0;
        var bridge = new JavaScriptInjectorBridge(() =>
        {
            locateCalls++;
            return null;
        });
        var registrar = new BrowserScriptRegistrar(bridge, () => "script body", logger);
        var config = new PluginConfiguration();

        registrar.Apply(config);
        registrar.Apply(config);

        Assert.Equal(2, locateCalls);
        Assert.Equal(LoaderRegistrationState.InjectorMissing, registrar.State);
        Assert.Equal(2, logger.Entries.Count(entry => entry.Level == LogLevel.Warning
            && entry.Message.Contains("JavaScript Injector plugin was not found", StringComparison.Ordinal)));
    }

    [Fact]
    public void Apply_ReportsAnUnreadableScriptInsteadOfThrowing()
    {
        var logger = new ListLogger<BrowserScriptRegistrar>();
        var injector = new CountingInjector();
        var registrar = new BrowserScriptRegistrar(
            new JavaScriptInjectorBridge(() => typeof(CountingInjector.Interface)),
            () => throw new IOException("gone"),
            logger);

        registrar.Apply(new PluginConfiguration());

        Assert.Equal(0, injector.RegisterCalls);
        Assert.Equal(LoaderRegistrationState.Failed, registrar.State);
        Assert.Contains("gone", registrar.Detail, StringComparison.Ordinal);
        Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Warning
            && entry.Message.Contains("gone", StringComparison.Ordinal));
    }

    [Fact]
    public async Task StartAsync_RegistersAndFollowsSettingsSavesUntilStopped()
    {
        var plugin = PluginTestHost.WithConfiguration(new PluginConfiguration());
        var injector = new CountingInjector();
        var registrar = injector.CreateRegistrar(new ListLogger<BrowserScriptRegistrar>());

        await registrar.StartAsync(CancellationToken.None);
        Assert.Equal(1, injector.RegisterCalls);

        plugin.UpdateConfiguration(new PluginConfiguration { Enabled = false });
        Assert.Equal(1, injector.UnregisterCalls);

        await registrar.StopAsync(CancellationToken.None);
        plugin.UpdateConfiguration(new PluginConfiguration { Enabled = true });
        Assert.Equal(1, injector.RegisterCalls);
    }

    [Fact]
    public void EmbeddedLoader_LoadsThePageFromThisPluginsVersionedEndpoint()
    {
        var script = BrowserScriptRegistrar.LoadScript();

        Assert.Contains("'Plugins/SeerrIntegration/Client/seerr-integration.js'", script, StringComparison.Ordinal);
        Assert.Contains("'" + BrowserScriptRegistrar.VersionToken + "'", script, StringComparison.Ordinal);
    }

    [Fact]
    public void EmbeddedLoader_StaysInEs5Syntax()
    {
        // JavaScript Injector serves every plugin's script as one file, so syntax an older TV
        // browser cannot parse would take the other plugins' scripts down with this one.
        var script = BrowserScriptRegistrar.LoadScript();

        Assert.DoesNotContain("=>", script, StringComparison.Ordinal);
        Assert.DoesNotContain("`", script, StringComparison.Ordinal);
        Assert.DoesNotMatch(new Regex(@"(?<![\w$-])(let|const|class|async|await)\s+[\w$]"), script);
    }

    private sealed class CountingInjector
    {
        public CountingInjector()
        {
            Interface.Reset();
        }

        public int RegisterCalls => Interface.RegisterCalls;

        public int UnregisterCalls => Interface.UnregisterCalls;

        public string? LastPayloadJson => Interface.LastPayloadJson;

        public string? LastUnregisteredId => Interface.LastUnregisteredId;

        public BrowserScriptRegistrar CreateRegistrar(ILogger<BrowserScriptRegistrar> logger)
            => new(new JavaScriptInjectorBridge(() => typeof(Interface)), () => "script body", logger);

        /// <summary>
        /// Static like the real PluginInterface. Only this test class uses it, and xUnit runs a
        /// class's tests one at a time.
        /// </summary>
        public static class Interface
        {
            public static int RegisterCalls { get; private set; }

            public static int UnregisterCalls { get; private set; }

            public static string? LastPayloadJson { get; private set; }

            public static string? LastUnregisteredId { get; private set; }

            public static void Reset()
            {
                RegisterCalls = 0;
                UnregisterCalls = 0;
                LastPayloadJson = null;
                LastUnregisteredId = null;
            }

            public static bool RegisterScript(JavaScriptInjectorBridgeTests.FakePayload payload)
            {
                RegisterCalls++;
                LastPayloadJson = payload.Json;
                return true;
            }

            public static bool UnregisterScript(string scriptId)
            {
                UnregisterCalls++;
                LastUnregisteredId = scriptId;
                return true;
            }
        }
    }
}
