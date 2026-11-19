using Jellyfin.Plugin.SeerrIntegration.Browser;
using Jellyfin.Plugin.SeerrIntegration.Configuration;
using MediaBrowser.Controller;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using NSubstitute;

namespace Jellyfin.Plugin.SeerrIntegration.Tests;

[Collection("PluginInstance")]
public class PluginTests
{
    [Fact]
    public void PluginId_IsThisPluginsOwnGuid()
    {
        // scripts/verify-plugin-guid.sh enforces this across the repository; this pins the
        // value the assembly itself reports.
        Assert.Equal(Guid.Parse("c937e280-0ac7-4250-a620-8c5892e628fe"), Plugin.PluginId);
        Assert.Equal(Guid.Parse("1ac3cf0f-f0f9-443a-be08-be38e48ff683"), SeerrProxyPlugin.Id);
    }

    [Fact]
    public void Plugin_ExposesItsIdentity()
    {
        var plugin = PluginTestHost.WithConfiguration(new PluginConfiguration());

        Assert.Equal("Seerr Integration", plugin.Name);
        Assert.Equal(Plugin.PluginId, plugin.Id);
        Assert.False(string.IsNullOrWhiteSpace(plugin.Description));
        Assert.Same(plugin, Plugin.Instance);
    }

    [Fact]
    public void Plugin_ServesTheEmbeddedConfigurationPage()
    {
        var plugin = PluginTestHost.WithConfiguration(new PluginConfiguration());

        var page = Assert.Single(plugin.GetPages());

        Assert.Equal("Seerr Integration", page.Name);
        using var stream = typeof(Plugin).Assembly.GetManifestResourceStream(page.EmbeddedResourcePath);
        Assert.NotNull(stream);
        using var reader = new StreamReader(stream);
        Assert.Contains(Plugin.PluginId.ToString("D"), reader.ReadToEnd(), StringComparison.Ordinal);
    }

    [Fact]
    public void Configuration_ShowsThePageByDefault()
    {
        Assert.True(new PluginConfiguration().Enabled);
    }

    [Fact]
    public void ServiceRegistrator_SharesOneRegistrarWithTheHost()
    {
        var services = new ServiceCollection();
        services.AddSingleton(typeof(ILogger<>), typeof(ListLogger<>));

        new PluginServiceRegistrator().RegisterServices(services, Substitute.For<IServerApplicationHost>());

        using var provider = services.BuildServiceProvider();
        var hosted = Assert.Single(provider.GetServices<IHostedService>());
        Assert.Same(provider.GetRequiredService<BrowserScriptRegistrar>(), hosted);
    }
}
