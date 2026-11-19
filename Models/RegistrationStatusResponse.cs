namespace Jellyfin.Plugin.SeerrIntegration.Models;

/// <summary>
/// Whether the Requests page is reaching Jellyfin Web, as shown on the settings page.
/// </summary>
public sealed class RegistrationStatusResponse
{
    /// <summary>
    /// Gets or sets a value indicating whether the page is switched on in this plugin's settings.
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Gets or sets the outcome of the last JavaScript Injector registration.
    /// </summary>
    public string LoaderState { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets why the last registration failed, when it did.
    /// </summary>
    public string? LoaderDetail { get; set; }

    /// <summary>
    /// Gets or sets the plugin version browsers load.
    /// </summary>
    public string Version { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets a value indicating whether Seerr Proxy is installed.
    /// </summary>
    public bool SeerrProxyInstalled { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether Seerr Proxy is loaded and active.
    /// </summary>
    public bool SeerrProxyActive { get; set; }
}
