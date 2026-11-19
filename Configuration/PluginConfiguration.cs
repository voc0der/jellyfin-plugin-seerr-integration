using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.SeerrIntegration.Configuration;

/// <summary>
/// Seerr Integration plugin configuration.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PluginConfiguration"/> class.
    /// </summary>
    public PluginConfiguration()
    {
        Enabled = true;
    }

    /// <summary>
    /// Gets or sets a value indicating whether Jellyfin Web shows the Requests page.
    /// </summary>
    /// <remarks>
    /// Switching it off removes the page's loader from JavaScript Injector, so browsers stop
    /// loading the page on their next refresh. Requests themselves are always governed by
    /// Seerr Proxy and Seerr, never by this setting.
    /// </remarks>
    public bool Enabled { get; set; }
}
