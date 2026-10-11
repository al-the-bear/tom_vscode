/// Workspace discovery across VS Code CLI bridge ports.
///
/// Multiple VS Code windows each run a CLI Integration Server on a distinct
/// port in the inclusive range [defaultVSCodeBridgePort]–[maxVSCodeBridgePort].
/// [findBridgePortForWorkspace] scans that range, asks each responsive bridge
/// which workspace its window has open (a lightweight window-identity
/// handshake over `workspace.getInfoVce`), and returns the first port whose
/// workspace matches the requested name. [findBridgePortsForWorkspace] returns
/// **every** such port — two windows with the same workspace open answer
/// identically, and only the plural form lets a caller see the second one.
///
/// The production transport (`VSCodeBridgeClient.isAvailable` for probing and
/// a `workspace.getInfoVce` round-trip for identity) is injected through the
/// [probe] / [fetchIdentity] seams so the scan can be tested against faked
/// per-port bridges.
library;

import 'tom_workspace_api.dart';
import 'vscode.dart';
import 'vscode_bridge_adapter.dart';
import 'vscode_bridge_client.dart';

/// Probes whether a bridge is listening on [host]:[port].
///
/// The production default delegates to [VSCodeBridgeClient.isAvailable].
typedef BridgePortProbe = Future<bool> Function(String host, int port);

/// Fetches the workspace identity name reported by the bridge on [host]:[port],
/// or `null` if the bridge does not answer / has no identifiable workspace.
///
/// The identity name is the open `.code-workspace` file's name, or the
/// workspace root folder basename when no `.code-workspace` is open.
typedef BridgeIdentityFetcher = Future<String?> Function(String host, int port);

/// Thrown by [findBridgePortForWorkspace] when no responsive bridge in the
/// scanned range has the requested workspace open.
class BridgeWorkspaceNotFoundException implements Exception {
  /// The workspace name that was searched for.
  final String workspaceName;

  /// The first port scanned (inclusive).
  final int minPort;

  /// The last port scanned (inclusive).
  final int maxPort;

  BridgeWorkspaceNotFoundException(
    this.workspaceName,
    this.minPort,
    this.maxPort,
  );

  @override
  String toString() =>
      'BridgeWorkspaceNotFoundException: no VS Code bridge in ports '
      '$minPort–$maxPort has workspace "$workspaceName" open.';
}

/// Scans the CLI bridge port range for the window whose workspace matches
/// [name] and returns its port.
///
/// Ports are probed in ascending order from [minPort] to [maxPort] (inclusive,
/// defaulting to the full [defaultVSCodeBridgePort]–[maxVSCodeBridgePort]
/// range). For each responsive port the bridge's workspace identity is fetched
/// and compared to [name] (normalised so the bare workspace name, a
/// `.code-workspace` filename, and VS Code's `" (Workspace)"` multi-root
/// suffix all match each other). The first matching port is returned, and the
/// scan stops there.
///
/// **Deliberately silent about a duplicate.** Two VS Code windows with the
/// same workspace open report the same identity; this function takes the
/// lowest port and does not look further, because a helper that refused on
/// ambiguity would break the common single-window case for a condition that
/// is benign — every such window reaches the same extension. A caller that
/// wants to *know* whether the name was ambiguous — because a user typed it
/// as a pin and deserves to hear what it selected — uses
/// [findBridgePortsForWorkspace] and reports the collision itself.
///
/// Throws a [BridgeWorkspaceNotFoundException] if no responsive bridge in the
/// range reports a matching workspace.
Future<int> findBridgePortForWorkspace(
  String name, {
  String host = '127.0.0.1',
  int minPort = defaultVSCodeBridgePort,
  int maxPort = maxVSCodeBridgePort,
  BridgePortProbe probe = _defaultProbe,
  BridgeIdentityFetcher fetchIdentity = fetchBridgeWorkspaceName,
}) async {
  final target = normalizeWorkspaceName(name);
  for (var port = minPort; port <= maxPort; port++) {
    if (!await probe(host, port)) continue;
    final identity = await fetchIdentity(host, port);
    if (identity == null) continue;
    if (normalizeWorkspaceName(identity) == target) return port;
  }
  throw BridgeWorkspaceNotFoundException(name, minPort, maxPort);
}

/// Scans the CLI bridge port range and returns **every** port whose window
/// has the workspace [name] open, ascending; empty when none does.
///
/// One [scanBridgePorts] pass over [minPort]–[maxPort], each identity matched
/// with [normalizeWorkspaceName] exactly as [findBridgePortForWorkspace]
/// matches it — so the plural and the singular can never disagree about which
/// windows match, only about how many they report. The singular stops at the
/// first match and is the right call when any matching window will do; this
/// is the right call when the caller must be able to say that a name matched
/// more than one window, which the singular cannot tell it.
///
/// Returns an empty list rather than throwing when nothing matches: "no
/// window" and "one window" and "two windows" are three answers to the same
/// question, and a caller asking it is already prepared to read a count.
Future<List<int>> findBridgePortsForWorkspace(
  String name, {
  String host = '127.0.0.1',
  int minPort = defaultVSCodeBridgePort,
  int maxPort = maxVSCodeBridgePort,
  BridgePortProbe probe = _defaultProbe,
  BridgeIdentityFetcher fetchIdentity = fetchBridgeWorkspaceName,
}) async {
  final target = normalizeWorkspaceName(name);
  final table = await scanBridgePorts(
    host: host,
    minPort: minPort,
    maxPort: maxPort,
    probe: probe,
    fetchIdentity: fetchIdentity,
  );
  final ports = table.keys.toList()..sort();
  return [
    for (final port in ports)
      if (normalizeWorkspaceName(table[port]!) == target) port,
  ];
}

/// Scans the CLI bridge port range and returns a `port → workspace` table for
/// every responsive bridge.
///
/// Ports are probed in ascending order from [minPort] to [maxPort] (inclusive,
/// defaulting to the full [defaultVSCodeBridgePort]–[maxVSCodeBridgePort]
/// range). Each responsive bridge's workspace identity is fetched; ports with
/// no bridge (or no identifiable workspace) are omitted. The returned map
/// preserves ascending port order.
///
/// Unlike [findBridgePortForWorkspace], the reported names are the bridges'
/// raw identity strings (not normalised) — scanning is a reporting concern,
/// name normalisation is a matching concern.
Future<Map<int, String>> scanBridgePorts({
  String host = '127.0.0.1',
  int minPort = defaultVSCodeBridgePort,
  int maxPort = maxVSCodeBridgePort,
  BridgePortProbe probe = _defaultProbe,
  BridgeIdentityFetcher fetchIdentity = fetchBridgeWorkspaceName,
}) async {
  final table = <int, String>{};
  for (var port = minPort; port <= maxPort; port++) {
    if (!await probe(host, port)) continue;
    final identity = await fetchIdentity(host, port);
    if (identity == null) continue;
    table[port] = identity;
  }
  return table;
}

/// Creates a port-bound [LazyVSCodeBridgeAdapter] for a resolved bridge.
///
/// The production default constructs a real [LazyVSCodeBridgeAdapter]; tests
/// inject a double so [connectToWorkspace] can run without a socket.
typedef BridgeAdapterFactory =
    LazyVSCodeBridgeAdapter Function(String host, int port);

/// Resolves the bridge port for the workspace named [name] (via
/// [findBridgePortForWorkspace]) and returns a connected adapter bound to it.
///
/// The adapter is connected before returning; if the resolved bridge cannot be
/// connected a [StateError] is thrown. When [initializeVSCode] is `true`, the
/// returned adapter is also promoted to the global [VSCode] singleton so
/// `VSCode.instance` targets that window. The
/// [BridgeWorkspaceNotFoundException] raised by the underlying scan when no
/// window matches [name] propagates unchanged.
Future<LazyVSCodeBridgeAdapter> connectToWorkspace(
  String name, {
  String host = '127.0.0.1',
  int minPort = defaultVSCodeBridgePort,
  int maxPort = maxVSCodeBridgePort,
  BridgePortProbe probe = _defaultProbe,
  BridgeIdentityFetcher fetchIdentity = fetchBridgeWorkspaceName,
  bool initializeVSCode = false,
  BridgeAdapterFactory adapterFactory = _defaultAdapterFactory,
}) async {
  final port = await findBridgePortForWorkspace(
    name,
    host: host,
    minPort: minPort,
    maxPort: maxPort,
    probe: probe,
    fetchIdentity: fetchIdentity,
  );
  final adapter = adapterFactory(host, port);
  final connected = await adapter.connect();
  if (!connected) {
    throw StateError(
      'Found workspace "$name" on port $port but could not connect to its '
      'bridge.',
    );
  }
  if (initializeVSCode) VSCode.initialize(adapter);
  return adapter;
}

/// Default [BridgeAdapterFactory] — a real [LazyVSCodeBridgeAdapter].
LazyVSCodeBridgeAdapter _defaultAdapterFactory(String host, int port) =>
    LazyVSCodeBridgeAdapter(host: host, port: port);

/// Default [BridgePortProbe] — delegates to [VSCodeBridgeClient.isAvailable].
Future<bool> _defaultProbe(String host, int port) =>
    VSCodeBridgeClient.isAvailable(host: host, port: port);

/// Default [BridgeIdentityFetcher] — connects to the bridge on [host]:[port],
/// issues a `workspace.getInfoVce` window-identity handshake, and derives the
/// workspace name from the result. Returns `null` if the bridge cannot be
/// reached or yields no identifiable workspace.
Future<String?> fetchBridgeWorkspaceName(String host, int port) async {
  final client = VSCodeBridgeClient(host: host, port: port);
  try {
    if (!await client.connect()) return null;
    final result = await client.sendRequest('workspace.getInfoVce', {});
    return _deriveWorkspaceName(WorkspaceInfo.fromJson(result));
  } catch (_) {
    return null;
  } finally {
    await client.disconnect();
  }
}

/// Derives the canonical workspace identity name from a [WorkspaceInfo].
///
/// Prefers the open `.code-workspace` file's name, then the reported workspace
/// name, then the root folder basename.
String? _deriveWorkspaceName(WorkspaceInfo info) {
  final file = info.workspaceFile;
  if (file != null && file.isNotEmpty) return _basename(file);
  if (info.name.isNotEmpty) return info.name;
  if (info.rootPath.isNotEmpty) return _basename(info.rootPath);
  return null;
}

/// Normalises a workspace name for comparison: trims whitespace, drops a
/// trailing `.code-workspace` extension, and strips VS Code's `" (Workspace)"`
/// multi-root suffix.
String normalizeWorkspaceName(String value) {
  var v = value.trim();
  const ext = '.code-workspace';
  if (v.endsWith(ext)) v = v.substring(0, v.length - ext.length);
  const suffix = ' (Workspace)';
  if (v.endsWith(suffix)) v = v.substring(0, v.length - suffix.length);
  return v.trim();
}

/// Returns the final path segment of [path], handling both `/` and `\`.
String _basename(String path) {
  final normalized = path.replaceAll('\\', '/');
  final trimmed = normalized.endsWith('/')
      ? normalized.substring(0, normalized.length - 1)
      : normalized;
  final slash = trimmed.lastIndexOf('/');
  return slash == -1 ? trimmed : trimmed.substring(slash + 1);
}
