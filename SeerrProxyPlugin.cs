namespace Jellyfin.Plugin.SeerrIntegration;

/// <summary>
/// The Seerr Proxy plugin, which carries every Seerr call the Requests page makes.
/// </summary>
/// <remarks>
/// Kept apart from <see cref="Plugin"/> so that file names exactly one GUID, its own, which is
/// what <c>scripts/verify-plugin-guid.sh</c> checks.
/// </remarks>
public static class SeerrProxyPlugin
{
    /// <summary>
    /// Seerr Proxy's plugin identifier.
    /// </summary>
    public static readonly Guid Id = Guid.Parse("1ac3cf0f-f0f9-443a-be08-be38e48ff683");
}
