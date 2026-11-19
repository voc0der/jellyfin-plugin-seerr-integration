using Jellyfin.Plugin.SeerrIntegration.Browser;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.SeerrIntegration;

/// <summary>
/// Registers plugin services.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // One instance, so the configuration page's status endpoint reads the same
        // registration state the hosted service writes.
        serviceCollection.AddSingleton<BrowserScriptRegistrar>();
        serviceCollection.AddHostedService(provider => provider.GetRequiredService<BrowserScriptRegistrar>());
    }
}
