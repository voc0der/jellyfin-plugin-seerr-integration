using System.Net.Mime;
using Jellyfin.Plugin.SeerrIntegration.Browser;
using Jellyfin.Plugin.SeerrIntegration.Models;
using MediaBrowser.Common.Api;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using SeerrIntegrationPlugin = Jellyfin.Plugin.SeerrIntegration.Plugin;

namespace Jellyfin.Plugin.SeerrIntegration.Api;

/// <summary>
/// Serves the Requests page to Jellyfin Web and reports its state to the settings page.
/// </summary>
/// <remarks>
/// Nothing here talks to Seerr. The page calls Seerr Proxy itself, as the signed-in user, so
/// this plugin holds no Seerr credential and makes no request on anybody's behalf.
/// </remarks>
[ApiController]
[Authorize]
[Route("Plugins/SeerrIntegration")]
public class SeerrIntegrationController : ControllerBase
{
    /// <summary>
    /// Client files this endpoint serves, keyed by the name in the URL, so a path can never
    /// be used to read another embedded resource.
    /// </summary>
    private static readonly Dictionary<string, (string Resource, string ContentType)> ClientFiles = new(StringComparer.Ordinal)
    {
        ["seerr-integration.js"] = ("Jellyfin.Plugin.SeerrIntegration.Web.seerr-integration.js", "application/javascript; charset=utf-8")
    };

    private readonly IPluginManager _pluginManager;
    private readonly BrowserScriptRegistrar _registrar;

    /// <summary>
    /// Initializes a new instance of the <see cref="SeerrIntegrationController"/> class.
    /// </summary>
    /// <param name="pluginManager">Jellyfin plugin manager, used for the kill switch and the proxy check.</param>
    /// <param name="registrar">Keeps the page's loader registered with JavaScript Injector.</param>
    public SeerrIntegrationController(IPluginManager pluginManager, BrowserScriptRegistrar registrar)
    {
        _pluginManager = pluginManager;
        _registrar = registrar;
    }

    /// <summary>
    /// Gets a file of the Requests page.
    /// </summary>
    /// <param name="fileName">The file name.</param>
    /// <param name="v">The plugin version the loader asked for; a match is cached for good.</param>
    /// <response code="200">The file.</response>
    /// <response code="404">The plugin is not active, or no such file exists.</response>
    /// <returns>The file contents.</returns>
    [HttpGet("Client/{fileName}")]
    // Loaded with a script tag, which cannot carry Jellyfin's authorization header. The file
    // is the same public code for everyone and holds nothing about any user or server.
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult GetClientFile([FromRoute] string fileName, [FromQuery] string? v)
    {
        if (!IsPluginActive() || !ClientFiles.TryGetValue(fileName, out var file))
        {
            return NotFound();
        }

        var stream = typeof(SeerrIntegrationController).Assembly.GetManifestResourceStream(file.Resource);
        if (stream is null)
        {
            return NotFound();
        }

        // The loader asks for its own version, so a matching URL never changes content. Any
        // other URL is revalidated, so a stale loader still gets the current page.
        Response.Headers.CacheControl = string.Equals(v, BrowserScriptRegistrar.GetVersion(), StringComparison.Ordinal)
            ? "public, max-age=31536000, immutable"
            : "no-cache";
        Response.Headers.XContentTypeOptions = "nosniff";
        return File(stream, file.ContentType);
    }

    /// <summary>
    /// Gets whether the Requests page is reaching Jellyfin Web, for the settings page.
    /// </summary>
    /// <response code="200">The registration state.</response>
    /// <response code="404">The plugin is not active.</response>
    /// <returns>The registration state.</returns>
    [HttpGet("Registration")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [Produces(MediaTypeNames.Application.Json)]
    [ProducesResponseType(typeof(RegistrationStatusResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<RegistrationStatusResponse> GetRegistration()
    {
        if (!IsPluginActive())
        {
            return NotFound();
        }

        var proxy = _pluginManager.Plugins.FirstOrDefault(candidate => candidate.Id.Equals(SeerrProxyPlugin.Id));
        return new RegistrationStatusResponse
        {
            Enabled = SeerrIntegrationPlugin.Instance?.Configuration.Enabled ?? false,
            LoaderState = _registrar.State.ToString(),
            LoaderDetail = _registrar.Detail,
            Version = BrowserScriptRegistrar.GetVersion(),
            SeerrProxyInstalled = proxy is not null,
            SeerrProxyActive = proxy is not null && proxy.IsEnabledAndSupported && proxy.Manifest.Status == PluginStatus.Active
        };
    }

    /// <summary>
    /// Determines whether Jellyfin currently considers this plugin fully active.
    /// </summary>
    /// <remarks>
    /// Same rule as Seerr Proxy's kill switch: controllers stay routed after the plugin is
    /// disabled at runtime, and a disabled plugin's in-memory status is <see cref="PluginStatus.Restart"/>,
    /// which <c>IsEnabledAndSupported</c> still counts as enabled. Fails closed when no record
    /// matches this assembly.
    /// </remarks>
    /// <returns><c>true</c> only if the plugin record is present, supported, and active.</returns>
    private bool IsPluginActive()
    {
        var plugin = _pluginManager.Plugins
            .FirstOrDefault(candidate => candidate.Id.Equals(SeerrIntegrationPlugin.PluginId));

        return plugin is not null
            && plugin.IsEnabledAndSupported
            && plugin.Manifest.Status == PluginStatus.Active;
    }
}
