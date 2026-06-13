/// VS Code Scripting API verification suite.
///
/// Connects to a running VS Code window's CLI Integration Server and exercises
/// the `tom_vscode_scripting_api` surface end-to-end, reporting PASS / FAIL /
/// SKIP per check. Use it to confirm that scripting works after rebuilding the
/// bridge (`tom_bs`) or bumping `tom_vscode_scripting_api`.
///
/// ## Running
///
/// Standalone (recommended — exercises the package directly over TCP):
///
/// ```bash
/// # auto-discover the single open window
/// dart run test_scripts/scripting_api_suite.dart
///
/// # target a specific window by workspace name or port
/// dart run test_scripts/scripting_api_suite.dart --workspace=tom_agent_container
/// dart run test_scripts/scripting_api_suite.dart --port=19900
///
/// # also run checks with visible side effects (status bar, info toast)
/// dart run test_scripts/scripting_api_suite.dart --interactive
/// ```
///
/// Through the bridge (`tom_bs`) the same source runs as a d4rt script, which
/// additionally verifies the bridged interpreter surface. See
/// `test_scripts/README.md`.
///
/// ## Prerequisites
///
/// In the target window run the command **"DS: Start Tom CLI Integration
/// Server"** (it listens on the first free port in 19900–19909).
///
/// Exit code is `0` when no check fails, `1` otherwise — so it doubles as a
/// smoke gate.
library;

import 'dart:io';

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Outcome of a single check.
enum _Status { pass, fail, skip }

/// A recorded check result.
class _Result {
  _Result(this.section, this.name, this.status, this.detail);

  final String section;
  final String name;
  final _Status status;
  final String detail;
}

/// Thrown by a check to record a SKIP (a precondition the window does not meet)
/// rather than a failure.
class _Skip implements Exception {
  _Skip(this.reason);
  final String reason;
}

/// A check returns a short human-readable detail string, throws [_Skip] to skip,
/// or throws anything else to fail.
typedef _Check = Future<String> Function();

/// Collects and renders check results.
class _Suite {
  final List<_Result> _results = [];
  String _section = '';
  static const _checkTimeout = Duration(seconds: 20);

  void section(String name) {
    _section = name;
    stdout.writeln('\n$name');
  }

  Future<void> check(String name, _Check fn) async {
    try {
      final detail = await fn().timeout(_checkTimeout);
      _record(name, _Status.pass, detail);
    } on _Skip catch (s) {
      _record(name, _Status.skip, s.reason);
    } catch (e) {
      _record(name, _Status.fail, e.toString());
    }
  }

  void _record(String name, _Status status, String detail) {
    _results.add(_Result(_section, name, status, detail));
    final tag = switch (status) {
      _Status.pass => 'PASS',
      _Status.fail => 'FAIL',
      _Status.skip => 'SKIP',
    };
    final shown = detail.length > 100 ? '${detail.substring(0, 100)}…' : detail;
    stdout.writeln('  [$tag] $name${shown.isEmpty ? '' : '  — $shown'}');
  }

  int get _count => _results.length;
  int get _passed => _results.where((r) => r.status == _Status.pass).length;
  int get _failed => _results.where((r) => r.status == _Status.fail).length;
  int get _skipped => _results.where((r) => r.status == _Status.skip).length;

  /// Prints the summary and returns the process exit code (0 ok, 1 failures).
  int report() {
    stdout.writeln('\n${'=' * 60}');
    stdout.writeln(
      'Total $_count   PASS $_passed   FAIL $_failed   SKIP $_skipped',
    );
    if (_failed > 0) {
      stdout.writeln('\nFailures:');
      for (final r in _results.where((r) => r.status == _Status.fail)) {
        stdout.writeln('  - ${r.section} / ${r.name}: ${r.detail}');
      }
    }
    stdout.writeln('=' * 60);
    return _failed > 0 ? 1 : 0;
  }
}

/// Parsed command-line options.
class _Options {
  _Options({
    required this.host,
    required this.port,
    required this.workspace,
    required this.interactive,
  });

  final String host;
  final int? port;
  final String? workspace;
  final bool interactive;

  static _Options parse(List<String> args) {
    String host = '127.0.0.1';
    int? port;
    String? workspace;
    bool interactive = false;
    for (final arg in args) {
      if (arg == '--interactive') {
        interactive = true;
      } else if (arg.startsWith('--host=')) {
        host = arg.substring('--host='.length);
      } else if (arg.startsWith('--port=')) {
        port = int.tryParse(arg.substring('--port='.length));
      } else if (arg.startsWith('--workspace=')) {
        workspace = arg.substring('--workspace='.length);
      } else if (arg == '--help' || arg == '-h') {
        _printUsage();
        exit(0);
      } else {
        stderr.writeln('Unknown argument: $arg');
        _printUsage();
        exit(2);
      }
    }
    return _Options(
      host: host,
      port: port,
      workspace: workspace,
      interactive: interactive,
    );
  }

  static void _printUsage() {
    stdout.writeln(
      'Usage: dart run test_scripts/scripting_api_suite.dart '
      '[--workspace=NAME | --port=N] [--host=H] [--interactive]\n'
      '  (no target)   auto-discover the single open window\n'
      '  --workspace   resolve the window by open workspace name\n'
      '  --port        connect directly to a CLI server port (19900–19909)\n'
      '  --host        bridge host (default 127.0.0.1)\n'
      '  --interactive include checks with visible side effects',
    );
  }
}

/// Resolves a connected, initialised adapter from the options. Throws on
/// failure with an actionable message.
Future<VSCodeAdapter> _connect(_Options opts) async {
  // Explicit port wins.
  if (opts.port != null) {
    final adapter = LazyVSCodeBridgeAdapter(host: opts.host, port: opts.port!);
    if (!await adapter.connect()) {
      throw StateError('Could not connect to ${opts.host}:${opts.port}.');
    }
    return adapter;
  }
  // Named workspace.
  if (opts.workspace != null) {
    return connectToWorkspace(opts.workspace!, host: opts.host);
  }
  // Auto-discover.
  final table = await scanBridgePorts(host: opts.host);
  if (table.isEmpty) {
    throw StateError(
      'No responsive CLI Integration Server found on ${opts.host} in '
      '19900–19909. Run "DS: Start Tom CLI Integration Server" in the target '
      'window.',
    );
  }
  if (table.length > 1) {
    final listed = table.entries.map((e) => '${e.key}→${e.value}').join(', ');
    throw StateError(
      'Multiple windows are open ($listed). Specify --workspace or --port.',
    );
  }
  final port = table.keys.first;
  final adapter = LazyVSCodeBridgeAdapter(host: opts.host, port: port);
  if (!await adapter.connect()) {
    throw StateError('Could not connect to discovered bridge on port $port.');
  }
  return adapter;
}

Future<void> main(List<String> args) async {
  final opts = _Options.parse(args);

  VSCodeAdapter adapter;
  try {
    adapter = await _connect(opts);
  } catch (e) {
    stderr.writeln('Connection failed: $e');
    exit(2);
  }

  VSCode.initialize(adapter);
  TomWorkspaceApi.setAdapter(adapter);
  TomTodoApi.setAdapter(adapter);
  TomQueueApi.setAdapter(adapter);

  final suite = _Suite();
  final vscode = VSCode.instance;

  // --- Core --------------------------------------------------------------
  suite.section('Core (VSCode)');
  await suite.check('getVersion', () async {
    final v = await vscode.getVersion();
    if (v.isEmpty) throw 'empty version string';
    return v;
  });
  await suite.check('getEnv', () async {
    final env = await vscode.getEnv();
    if (env.isEmpty) throw 'empty env map';
    return 'appName=${env['appName']}';
  });

  // --- Workspace ---------------------------------------------------------
  suite.section('Workspace');
  String? rootPath;
  await suite.check('getRootPath', () async {
    rootPath = await vscode.workspace.getRootPath();
    if (rootPath == null || rootPath!.isEmpty) throw 'no root path';
    return rootPath!;
  });
  await suite.check('getWorkspaceName', () async {
    final name = await vscode.workspace.getWorkspaceName();
    return name ?? '(unnamed)';
  });
  await suite.check('getWorkspaceFolders', () async {
    final folders = await vscode.workspace.getWorkspaceFolders();
    if (folders.isEmpty) throw 'no workspace folders';
    return '${folders.length} folder(s): ${folders.map((f) => f.name).take(3).join(', ')}';
  });
  String? probeFile;
  await suite.check('findFilePaths', () async {
    final paths = await vscode.workspace.findFilePaths(include: '**/*.md');
    if (paths.isEmpty) throw 'no markdown files found';
    probeFile = paths.first;
    return '${paths.length} match(es)';
  });
  await suite.check('fileExists + readFile', () async {
    if (probeFile == null) throw _Skip('no probe file from findFilePaths');
    final exists = await vscode.workspace.fileExists(probeFile!);
    if (!exists) throw 'fileExists=false for $probeFile';
    final text = await vscode.workspace.readFile(probeFile!);
    return '${text.length} bytes from ${_short(probeFile!, rootPath)}';
  });
  await suite.check('getConfiguration', () async {
    final cfg = await vscode.workspace.getConfiguration('editor', scope: null);
    if (cfg is! Map) throw 'expected a Map, got ${cfg.runtimeType}';
    return 'editor.* keys: ${cfg.length}';
  });

  // --- Commands ----------------------------------------------------------
  suite.section('Commands');
  await suite.check('getCommands', () async {
    final ids = await vscode.commands.getCommands(filterInternal: true);
    if (ids.isEmpty) throw 'no commands returned';
    return '${ids.length} command(s)';
  });

  // --- Extensions --------------------------------------------------------
  suite.section('Extensions');
  await suite.check('getAll', () async {
    final all = await vscode.extensions.getAll();
    if (all.isEmpty) throw 'no extensions returned';
    return '${all.length} extension(s)';
  });
  await suite.check('isInstalled(self)', () async {
    // The Tom AI extension must be present — it hosts this very server.
    final present = await vscode.extensions
        .isInstalled('peter-nicolai-alexis-kyaw.tom-ai-extension');
    if (!present) {
      throw _Skip('tom-ai-extension id not matched (publisher may differ)');
    }
    return 'tom-ai-extension installed';
  });

  // --- Window ------------------------------------------------------------
  suite.section('Window');
  await suite.check('getActiveTextEditor', () async {
    final editor = await vscode.window.getActiveTextEditor();
    return editor == null ? 'no active editor' : '${editor.document.uri}';
  });
  if (opts.interactive) {
    await suite.check('setStatusBarMessage (visible)', () async {
      await vscode.window
          .setStatusBarMessage('Scripting suite OK', timeout: 3000);
      return 'status bar updated';
    });
    await suite.check('showInformationMessage (visible)', () async {
      await vscode.window
          .showInformationMessage('VS Code scripting suite: hello');
      return 'info toast shown';
    });
  } else {
    suite._record(
      'window side-effect checks',
      _Status.skip,
      'pass --interactive to run them',
    );
  }

  // --- Tom feature APIs (1.1.0 additions) --------------------------------
  suite.section('Tom feature APIs');
  await suite.check('TomWorkspaceApi.listProjects', () async {
    final res = await TomWorkspaceApi.listProjects();
    return '${res.totalCount} project(s)';
  });
  await suite.check('TomWorkspaceApi.listQuests', () async {
    final res = await TomWorkspaceApi.listQuests();
    return '${res.totalCount} quest(s)';
  });
  await suite.check('TomWorkspaceApi.getActiveQuest', () async {
    final quest = await TomWorkspaceApi.getActiveQuest();
    return quest == null ? 'no active quest' : quest.id;
  });
  await suite.check('TomQueueApi.list', () async {
    final res = await TomQueueApi.list();
    return '${res.totalCount} queued item(s)';
  });
  await suite.check('TomTodoApi.listWorkspaceTodoFiles', () async {
    final res = await TomTodoApi.listWorkspaceTodoFiles();
    return '${res.files.length} todo file(s)';
  });

  final code = suite.report();

  // The socket keeps the VM alive; disconnect and exit explicitly.
  if (adapter is LazyVSCodeBridgeAdapter) {
    await adapter.disconnect();
  }
  exit(code);
}

/// Shortens [path] relative to [root] for compact reporting.
String _short(String path, String? root) {
  if (root != null && root.isNotEmpty && path.startsWith(root)) {
    final rel = path.substring(root.length);
    return rel.startsWith('/') ? rel.substring(1) : rel;
  }
  return path;
}
