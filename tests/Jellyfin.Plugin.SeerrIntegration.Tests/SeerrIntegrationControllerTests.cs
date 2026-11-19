using Jellyfin.Plugin.SeerrIntegration.Api;
using Jellyfin.Plugin.SeerrIntegration.Browser;
using Jellyfin.Plugin.SeerrIntegration.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using NSubstitute;

namespace Jellyfin.Plugin.SeerrIntegration.Tests;

[Collection("PluginInstance")]
public class SeerrIntegrationControllerTests
{
    [Fact]
    public void GetClientFile_ServesThePageScript()
    {
        var controller = CreateController(PluginStatus.Active);

        var result = Assert.IsType<FileStreamResult>(controller.GetClientFile("seerr-integration.js", null));

        Assert.Equal("application/javascript; charset=utf-8", result.ContentType);
        using var reader = new StreamReader(result.FileStream);
        var script = reader.ReadToEnd();
        Assert.Contains("window.SeerrIntegration", script, StringComparison.Ordinal);
        Assert.Equal("nosniff", controller.Response.Headers.XContentTypeOptions.ToString());
    }

    [Fact]
    public void GetClientFile_CachesTheCurrentVersionForGood()
    {
        var controller = CreateController(PluginStatus.Active);

        controller.GetClientFile("seerr-integration.js", BrowserScriptRegistrar.GetVersion());

        Assert.Equal("public, max-age=31536000, immutable", controller.Response.Headers.CacheControl.ToString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("0.0.0.1")]
    public void GetClientFile_RevalidatesAnyOtherVersion(string? version)
    {
        var controller = CreateController(PluginStatus.Active);

        controller.GetClientFile("seerr-integration.js", version);

        Assert.Equal("no-cache", controller.Response.Headers.CacheControl.ToString());
    }

    [Theory]
    [InlineData("seerr-integration.css")]
    [InlineData("bootstrap.js")]
    [InlineData("..%2Fconfigpage.html")]
    [InlineData("Jellyfin.Plugin.SeerrIntegration.Configuration.configPage.html")]
    public void GetClientFile_RefusesAnythingOutsideTheAllowlist(string fileName)
    {
        var controller = CreateController(PluginStatus.Active);

        Assert.IsType<NotFoundResult>(controller.GetClientFile(fileName, null));
    }

    [Theory]
    [InlineData(PluginStatus.Disabled)]
    [InlineData(PluginStatus.Restart)]
    [InlineData(PluginStatus.Malfunctioned)]
    public void GetClientFile_StopsServingWhenThePluginIsNotActive(PluginStatus status)
    {
        var controller = CreateController(status);

        Assert.IsType<NotFoundResult>(controller.GetClientFile("seerr-integration.js", null));
    }

    [Fact]
    public void GetClientFile_FailsClosedWithoutAPluginRecord()
    {
        var manager = Substitute.For<IPluginManager>();
        manager.Plugins.Returns(Array.Empty<LocalPlugin>());
        var controller = CreateController(manager);

        Assert.IsType<NotFoundResult>(controller.GetClientFile("seerr-integration.js", null));
    }

    [Fact]
    public void GetRegistration_ReportsTheLoaderAndTheProxy()
    {
        PluginTestHost.WithConfiguration(new PluginConfiguration { Enabled = true });
        var manager = Manager(PluginStatus.Active, proxyStatus: PluginStatus.Active);
        var controller = CreateController(manager);

        var result = controller.GetRegistration().Value!;

        Assert.True(result.Enabled);
        Assert.Equal("Pending", result.LoaderState);
        Assert.True(result.SeerrProxyInstalled);
        Assert.True(result.SeerrProxyActive);
        Assert.Equal(BrowserScriptRegistrar.GetVersion(), result.Version);
    }

    [Fact]
    public void GetRegistration_ReportsAnInactiveProxy()
    {
        PluginTestHost.WithConfiguration(new PluginConfiguration());
        var controller = CreateController(Manager(PluginStatus.Active, proxyStatus: PluginStatus.Disabled));

        var result = controller.GetRegistration().Value!;

        Assert.True(result.SeerrProxyInstalled);
        Assert.False(result.SeerrProxyActive);
    }

    [Fact]
    public void GetRegistration_ReportsAMissingProxy()
    {
        PluginTestHost.WithConfiguration(new PluginConfiguration());
        var controller = CreateController(Manager(PluginStatus.Active, proxyStatus: null));

        var result = controller.GetRegistration().Value!;

        Assert.False(result.SeerrProxyInstalled);
        Assert.False(result.SeerrProxyActive);
    }

    [Fact]
    public void GetRegistration_StopsAnsweringWhenThePluginIsNotActive()
    {
        var controller = CreateController(PluginStatus.Disabled);

        Assert.IsType<NotFoundResult>(controller.GetRegistration().Result);
    }

    private static SeerrIntegrationController CreateController(PluginStatus status)
        => CreateController(Manager(status, proxyStatus: PluginStatus.Active));

    private static SeerrIntegrationController CreateController(IPluginManager manager)
    {
        var registrar = new BrowserScriptRegistrar(
            new JavaScriptInjectorBridge(() => null),
            () => string.Empty,
            new ListLogger<BrowserScriptRegistrar>());
        return new SeerrIntegrationController(manager, registrar)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
    }

    private static IPluginManager Manager(PluginStatus status, PluginStatus? proxyStatus)
    {
        var plugins = new List<LocalPlugin>
        {
            new("/plugins/seerr-integration", true, new PluginManifest
            {
                Id = Plugin.PluginId,
                Name = "Seerr Integration",
                Version = "1.0.0.0",
                Status = status
            })
        };
        if (proxyStatus is not null)
        {
            plugins.Add(new LocalPlugin("/plugins/seerr-proxy", true, new PluginManifest
            {
                Id = SeerrProxyPlugin.Id,
                Name = "Seerr Proxy",
                Version = "1.0.0.15",
                Status = proxyStatus.Value
            }));
        }

        var manager = Substitute.For<IPluginManager>();
        manager.Plugins.Returns(plugins);
        return manager;
    }
}
