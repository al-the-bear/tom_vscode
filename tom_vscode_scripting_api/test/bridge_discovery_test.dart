/// Tests for [findBridgePortForWorkspace] — the workspace-discovery scan that
/// locates the CLI bridge port (19900–19909) whose open window matches a given
/// workspace name. The production transport (`VSCodeBridgeClient.isAvailable`
/// + `workspace.getInfoVce`) is replaced here by injected `probe` /
/// `fetchIdentity` doubles, mirroring the established injected-seam pattern,
/// so the scan can be exercised against faked per-port bridges.
library;

import 'package:test/test.dart';
import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

void main() {
  group('findBridgePortForWorkspace', () {
    test('returns the first port whose workspace matches the name', () async {
      final responsive = {19900, 19902, 19905};
      final identities = <int, String>{
        19900: 'other_workspace',
        19902: 'vscode_extension',
        19905: 'third_workspace',
      };

      final port = await findBridgePortForWorkspace(
        'vscode_extension',
        probe: (host, p) async => responsive.contains(p),
        fetchIdentity: (host, p) async => identities[p],
      );

      expect(port, 19902);
    });

    test('scans the full 19900–19909 range', () async {
      final probed = <int>[];

      final port = await findBridgePortForWorkspace(
        'last',
        probe: (host, p) async {
          probed.add(p);
          return true;
        },
        fetchIdentity: (host, p) async => p == 19909 ? 'last' : 'nope',
      );

      expect(port, 19909);
      expect(probed, [
        19900, 19901, 19902, 19903, 19904,
        19905, 19906, 19907, 19908, 19909,
      ]);
    });

    test('skips unresponsive ports without fetching their identity', () async {
      final fetched = <int>[];

      final port = await findBridgePortForWorkspace(
        'target',
        probe: (host, p) async => p == 19903,
        fetchIdentity: (host, p) async {
          fetched.add(p);
          return 'target';
        },
      );

      expect(port, 19903);
      expect(fetched, [19903], reason: 'only the responsive port is queried');
    });

    test('throws BridgeWorkspaceNotFoundException when no bridge matches',
        () async {
      expect(
        () => findBridgePortForWorkspace(
          'absent',
          probe: (host, p) async => p == 19900 || p == 19901,
          fetchIdentity: (host, p) async => 'present',
        ),
        throwsA(isA<BridgeWorkspaceNotFoundException>()),
      );
    });

    test('throws when no bridge is responsive at all', () async {
      expect(
        () => findBridgePortForWorkspace(
          'anything',
          probe: (host, p) async => false,
          fetchIdentity: (host, p) async => 'whatever',
        ),
        throwsA(isA<BridgeWorkspaceNotFoundException>()),
      );
    });

    test('ignores responsive bridges whose identity is null', () async {
      final port = await findBridgePortForWorkspace(
        'good',
        probe: (host, p) async => true,
        fetchIdentity: (host, p) async => p == 19904 ? 'good' : null,
      );

      expect(port, 19904);
    });

    test('matches a .code-workspace filename against the bare name', () async {
      final port = await findBridgePortForWorkspace(
        'vscode_extension',
        probe: (host, p) async => p == 19901,
        fetchIdentity: (host, p) async => 'vscode_extension.code-workspace',
      );

      expect(port, 19901);
    });

    test('matches when the requested name carries the .code-workspace ext',
        () async {
      final port = await findBridgePortForWorkspace(
        'vscode_extension.code-workspace',
        probe: (host, p) async => p == 19901,
        fetchIdentity: (host, p) async => 'vscode_extension',
      );

      expect(port, 19901);
    });

    test('strips the VS Code " (Workspace)" multi-root suffix when matching',
        () async {
      final port = await findBridgePortForWorkspace(
        'enterprise_flutter',
        probe: (host, p) async => p == 19902,
        fetchIdentity: (host, p) async => 'enterprise_flutter (Workspace)',
      );

      expect(port, 19902);
    });

    test('honours a custom port range', () async {
      final probed = <int>[];

      final port = await findBridgePortForWorkspace(
        'target',
        minPort: 19905,
        maxPort: 19907,
        probe: (host, p) async {
          probed.add(p);
          return true;
        },
        fetchIdentity: (host, p) async => p == 19906 ? 'target' : 'no',
      );

      expect(port, 19906);
      expect(probed, [19905, 19906]);
    });
  });

  group('bridge port constants', () {
    test('cover the documented 19900–19909 CLI range', () {
      expect(defaultVSCodeBridgePort, 19900);
      expect(maxVSCodeBridgePort, 19909);
    });
  });
}
