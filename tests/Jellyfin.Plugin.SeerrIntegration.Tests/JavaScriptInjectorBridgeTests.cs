using System.Text.Json;
using Jellyfin.Plugin.SeerrIntegration.Browser;

namespace Jellyfin.Plugin.SeerrIntegration.Tests;

public class JavaScriptInjectorBridgeTests
{
    private static readonly InjectorScript Script = new(
        "plugin-id-requests-page",
        "Seerr Integration Requests page",
        "console.log('hi \"there\"');\n",
        RequiresAuthentication: true,
        "plugin-id",
        "Seerr Integration",
        "1.0.0.0");

    [Fact]
    public void LocatePluginInterface_FindsNothingWhenTheInjectorIsNotLoaded()
    {
        Assert.Null(JavaScriptInjectorBridge.LocatePluginInterface());
        Assert.Equal(InjectorRegistrationStatus.NotInstalled, new JavaScriptInjectorBridge().Register(Script).Status);
    }

    [Fact]
    public void Register_BuildsThePayloadWithTheInjectorsOwnParseMethod()
    {
        var bridge = new JavaScriptInjectorBridge(() => typeof(AcceptingInjector));

        var result = bridge.Register(Script);

        Assert.Equal(InjectorRegistrationStatus.Registered, result.Status);
        var payload = Assert.Single(AcceptingInjector.Payloads);
        using var document = JsonDocument.Parse(payload.Json);
        var root = document.RootElement;
        Assert.Equal("plugin-id-requests-page", root.GetProperty("id").GetString());
        Assert.Equal("Seerr Integration Requests page", root.GetProperty("name").GetString());
        Assert.Equal("console.log('hi \"there\"');\n", root.GetProperty("script").GetString());
        Assert.True(root.GetProperty("enabled").GetBoolean());
        Assert.True(root.GetProperty("requiresAuthentication").GetBoolean());
        Assert.Equal("plugin-id", root.GetProperty("pluginId").GetString());
        Assert.Equal("Seerr Integration", root.GetProperty("pluginName").GetString());
        Assert.Equal("1.0.0.0", root.GetProperty("pluginVersion").GetString());
    }

    [Fact]
    public void Register_ReportsFailureWhenTheInjectorDeclines()
    {
        var result = new JavaScriptInjectorBridge(() => typeof(DecliningInjector)).Register(Script);

        Assert.Equal(InjectorRegistrationStatus.Failed, result.Status);
        Assert.Contains("returned false", result.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void Register_NeverThrowsWhenTheInjectorDoes()
    {
        var result = new JavaScriptInjectorBridge(() => typeof(ThrowingInjector)).Register(Script);

        Assert.Equal(InjectorRegistrationStatus.Failed, result.Status);
        Assert.Contains("InvalidOperationException", result.Detail, StringComparison.Ordinal);
        Assert.Contains("instance is not available", result.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void Register_NeverThrowsWhenLookingForTheInjectorDoes()
    {
        var result = new JavaScriptInjectorBridge(() => throw new BadImageFormatException("corrupt")).Register(Script);

        Assert.Equal(InjectorRegistrationStatus.Failed, result.Status);
    }

    [Theory]
    [InlineData(typeof(NoRegisterMethodInjector))]
    [InlineData(typeof(UnparseablePayloadInjector))]
    public void Register_ReportsFailureForAnInterfaceOfAnotherShape(Type pluginInterface)
    {
        var result = new JavaScriptInjectorBridge(() => pluginInterface).Register(Script);

        Assert.Equal(InjectorRegistrationStatus.Failed, result.Status);
    }

    [Fact]
    public void Unregister_RemovesTheScriptById()
    {
        var bridge = new JavaScriptInjectorBridge(() => typeof(AcceptingInjector));

        Assert.True(bridge.Unregister("plugin-id-requests-page"));
        Assert.Contains("plugin-id-requests-page", AcceptingInjector.Unregistered);
    }

    [Fact]
    public void Unregister_IsQuietWhenTheInjectorIsMissingOrBroken()
    {
        Assert.False(new JavaScriptInjectorBridge(() => null).Unregister("id"));
        Assert.False(new JavaScriptInjectorBridge(() => typeof(ThrowingInjector)).Unregister("id"));
        Assert.False(new JavaScriptInjectorBridge(() => throw new InvalidOperationException()).Unregister("id"));
    }

    /// <summary>
    /// Stands in for Newtonsoft's JObject: the bridge only relies on a static Parse(string).
    /// </summary>
    public sealed class FakePayload
    {
        private FakePayload(string json)
        {
            Json = json;
        }

        public string Json { get; }

        public static FakePayload Parse(string json) => new(json);
    }

    public sealed class PayloadWithoutParse
    {
    }

    public static class AcceptingInjector
    {
        public static List<FakePayload> Payloads { get; } = new();

        public static List<string> Unregistered { get; } = new();

        public static bool RegisterScript(FakePayload payload)
        {
            Payloads.Add(payload);
            return true;
        }

        public static bool UnregisterScript(string scriptId)
        {
            Unregistered.Add(scriptId);
            return true;
        }
    }

    public static class DecliningInjector
    {
        public static bool RegisterScript(FakePayload payload) => false;
    }

    public static class ThrowingInjector
    {
        public static bool RegisterScript(FakePayload payload)
            => throw new InvalidOperationException("JavaScript Injector plugin instance is not available.");

        public static bool UnregisterScript(string scriptId)
            => throw new InvalidOperationException("broken");
    }

    public static class NoRegisterMethodInjector
    {
        public static bool UnregisterScript(string scriptId) => true;
    }

    public static class UnparseablePayloadInjector
    {
        public static bool RegisterScript(PayloadWithoutParse payload) => true;
    }
}
