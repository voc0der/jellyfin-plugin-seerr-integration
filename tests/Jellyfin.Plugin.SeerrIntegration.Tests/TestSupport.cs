using Jellyfin.Plugin.SeerrIntegration.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;
using NSubstitute;

namespace Jellyfin.Plugin.SeerrIntegration.Tests;

/// <summary>
/// Stands a <see cref="Plugin"/> instance up around a given configuration.
/// </summary>
/// <remarks>
/// Jellyfin loads a plugin's configuration lazily through <see cref="IXmlSerializer"/>, so
/// answering <c>DeserializeFromFile</c> with the desired object installs it without touching
/// disk. The constructor assigns the process-wide <c>Plugin.Instance</c>, so every test class
/// that constructs a plugin joins the <c>PluginInstance</c> collection.
/// </remarks>
internal static class PluginTestHost
{
    public static Plugin WithConfiguration(PluginConfiguration configuration)
    {
        var applicationPaths = Substitute.For<IApplicationPaths>();
        applicationPaths.PluginConfigurationsPath.Returns(Path.Combine(Path.GetTempPath(), "seerr-integration-tests"));

        var xmlSerializer = Substitute.For<IXmlSerializer>();
        xmlSerializer.DeserializeFromFile(typeof(PluginConfiguration), Arg.Any<string>())
            .Returns(configuration);

        var plugin = new Plugin(applicationPaths, xmlSerializer);
        _ = plugin.Configuration;
        return plugin;
    }
}

[CollectionDefinition("PluginInstance")]
public sealed class PluginInstanceCollection
{
}

internal sealed class ListLogger<T> : ILogger<T>
{
    public List<(LogLevel Level, string Message)> Entries { get; } = new();

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull
        => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
        => Entries.Add((logLevel, formatter(state, exception)));
}
