// REPO-WIDE GUARD (tom_vscode_scripting_api) — no package in the tom_vscode repo
// resolves a tom_* version behind one already in the pub cache.
//
// Its subject reaches OUTSIDE this package: it walks every package under the
// repo root, including the bridge and the four samples under `example/`. It
// lives here because this package owns those samples and its suite is the fast
// one in the repo; it runs only when this suite runs.
//
// Copied from `tom_ai/d4rt/tom_d4rt_ast/test/scc45_resolution_guard_test.dart`
// (SCC45 / DGUC10), cut down to the cases that are not d4rt-specific. Read that
// file for the full history; the short version follows.
//
// THE DEFECT
//
// `pubspec.lock` is gitignored workspace-wide, so what a package RESOLVES is
// per-machine state no diff shows. `pub get` is LOCK-PRESERVING: a lower-bound
// constraint such as `>=1.1.0` ADMITS 1.1.2 but never SELECTS it once a lock
// exists. Measured 2026-10-02 in this repo: all four samples resolved
// `tom_vscode_scripting_api` 1.1.0 while 1.1.2 was published, and the bridge
// held six stale `tom_*` resolutions — one of them (`tom_d4rt_generator` 1.28.0)
// below its own pubspec's floor of `>=1.51.0`. A suite green against a frozen
// lock certifies a version nobody installs.
//
// THE CACHE IS THE DISCRIMINATOR, and the inference is one-directional on
// purpose. Comparing a lock against a sibling's `pubspec.yaml` cannot tell a
// frozen lock from an UNPUBLISHED sibling — both look like "the lock is
// behind". A newer version sitting in the pub cache proves pub HAD it and did
// not take it. A cold cache under-reports, so every pass is a statement about
// THIS machine, and the cache sensitivity is printed on every run for that
// reason.
//
// SEEN TO FAIL, 2026-10-02 (each fault injected, the case observed red, then
// reverted):
//
//   | Injected fault                                         | Fires        |
//   | ------------------------------------------------------ | ------------ |
//   | a sample's lock set back to scripting_api 1.1.0         | F-VSC-LOCK-2 |
//   | a sample's floor set back to `>=1.1.0`                  | F-VSC-LOCK-4 |
//   | the walk's depth limit lowered so samples are not found | -0 and -4    |
//
// REMEDY when F-VSC-LOCK-2 fires: `./_bin/check_frozen_locks.py tom_ai/vscode`
// from the workspace root lists the packages; run `dart pub upgrade` in each
// (the samples are nested packages with their own locks). If an upgrade does
// NOT move a version, either a constraint holds it (raise it) or the sibling
// working tree has unpublished work — publish it, do not re-resolve.

import 'dart:io';

import 'package:test/test.dart';

/// Packages whose presence identifies the tom_vscode repo root.
const _repoMarkers = [
  'tom_vscode_bridge',
  'tom_vscode_scripting_api',
  'tom_vscode_extension',
];

/// Only packages this workspace publishes can have an unpropagated publish.
const _ownedPrefix = 'tom_';

/// Below this many distinct cached `tom_*` packages the cache cannot tell a
/// frozen lock from a current one, so the cache-dependent cases skip rather
/// than report a meaningless pass. Same floor as the d4rt guard.
const int _minimumCachedPackages = 5;

/// Packages exempted from F-VSC-LOCK-2, each naming the todo that owns the
/// unfreeze. Empty, and F-VSC-LOCK-3 keeps it honest: an entry for a package
/// that is no longer frozen fails the suite.
const Map<String, String> _frozenLockExceptions = <String, String>{};

/// The library a sample demonstrates. F-VSC-LOCK-4 holds every copy surface's
/// floor on it to the current release; tool dependencies are left out, as in
/// the d4rt guard, because chasing every tool release through every sample is
/// churn that buys no truth.
const _demonstratedPackages = {'tom_vscode_scripting_api'};

/// The samples a new project copies — named so the walk cannot silently miss
/// them (F-VSC-LOCK-0).
const _knownSamples = {
  'tom_vscode_scripting_api/example/vscode_agent_sdk_sample',
  'tom_vscode_scripting_api/example/vscode_agent_tools_sample',
  'tom_vscode_scripting_api/example/vscode_scripting_advanced_sample',
  'tom_vscode_scripting_api/example/vscode_scripting_introduction_sample',
};

class _Resolution {
  const _Resolution(this.name, this.source, this.version);
  final String name;
  final String source;
  final String version;
}

Directory? _repoRoot() {
  var dir = Directory.current.absolute;
  for (var i = 0; i < 6; i++) {
    if (_repoMarkers.every((p) => Directory('${dir.path}/$p').existsSync())) {
      return dir;
    }
    final parent = dir.parent;
    if (parent.path == dir.path) break;
    dir = parent;
  }
  return null;
}

/// Every directory beneath [root] holding a pubspec — and, when [withLock],
/// a lock too. `.dart_tool`, `build` and `node_modules` are pruned: pub and npm
/// materialise package skeletons there that nobody maintains.
List<Directory> _packagesUnder(Directory root, {bool withLock = true}) {
  final found = <Directory>[];
  void walk(Directory dir, int depth) {
    if (depth > 5) return;
    final name = dir.path.split(Platform.pathSeparator).last;
    if (name.startsWith('.') || name == 'build' || name == 'node_modules') {
      return;
    }
    if (File('${dir.path}/pubspec.yaml').existsSync() &&
        (!withLock || File('${dir.path}/pubspec.lock').existsSync())) {
      found.add(dir);
    }
    for (final child in dir.listSync().whereType<Directory>()) {
      walk(child, depth + 1);
    }
  }

  walk(root, 0);
  return found;
}

String _relativeTo(Directory root, Directory dir) {
  final path = dir.path.startsWith(root.path)
      ? dir.path.substring(root.path.length + 1)
      : dir.path;
  return path.replaceAll(r'\', '/');
}

/// The `tom_*` entries of [package]'s lock. Parsed by hand: a lock is
/// machine-written, names sit at two spaces and their fields at four.
List<_Resolution> _lockedTomPackages(Directory package) {
  final lockFile = File('${package.path}/pubspec.lock');
  if (!lockFile.existsSync()) return const [];
  final namePattern = RegExp(r'^  ([A-Za-z0-9_]+):\s*$');
  final fieldPattern = RegExp(r'^    (source|version):\s*"?([^"]*)"?\s*$');
  final out = <_Resolution>[];
  String? current, source, version;
  void flush() {
    if (current != null &&
        current!.startsWith(_ownedPrefix) &&
        source != null &&
        version != null) {
      out.add(_Resolution(current!, source!, version!));
    }
    current = source = version = null;
  }

  for (final line in lockFile.readAsLinesSync()) {
    final name = namePattern.firstMatch(line);
    if (name != null) {
      flush();
      current = name.group(1);
      continue;
    }
    final field = fieldPattern.firstMatch(line);
    if (field == null || current == null) continue;
    if (field.group(1) == 'source') {
      source = field.group(2);
    } else {
      version = field.group(2);
    }
  }
  flush();
  return out;
}

/// `-1`, `0` or `1` by major.minor.patch; pre-release metadata is dropped.
int _compareVersions(String a, String b) {
  List<int> parts(String v) => v
      .split(RegExp(r'[-+]'))
      .first
      .split('.')
      .map((p) => int.tryParse(p) ?? 0)
      .toList();
  final pa = parts(a), pb = parts(b);
  for (var i = 0; i < 3; i++) {
    final x = i < pa.length ? pa[i] : 0, y = i < pb.length ? pb[i] : 0;
    if (x != y) return x.compareTo(y);
  }
  return 0;
}

/// The pub cache root, resolved as pub resolves it: `PUB_CACHE` when set and
/// non-empty, then `%LOCALAPPDATA%\Pub\Cache` on Windows, `$HOME/.pub-cache`
/// elsewhere. (The d4rt guard learned the Windows default the hard way on
/// legiondary01, SCE147.)
Directory _pubCacheRoot() {
  final explicit = Platform.environment['PUB_CACHE'];
  if (explicit != null && explicit.trim().isNotEmpty) {
    return Directory(explicit);
  }
  if (Platform.isWindows) {
    final localAppData = Platform.environment['LOCALAPPDATA'];
    if (localAppData != null && localAppData.isNotEmpty) {
      return Directory('$localAppData\\Pub\\Cache');
    }
  }
  return Directory('${Platform.environment['HOME'] ?? ''}/.pub-cache');
}

Directory get _hostedCache =>
    Directory('${_pubCacheRoot().path}/hosted/pub.dev');

/// The newest STABLE cached version of [name], or null.
String? _newestCachedVersion(String name) {
  final dir = _hostedCache;
  if (!dir.existsSync()) return null;
  final prefix = '$name-';
  final stable = dir
      .listSync()
      .whereType<Directory>()
      .map((d) => d.path.split(Platform.pathSeparator).last)
      .where((n) => n.startsWith(prefix))
      .map((n) => n.substring(prefix.length))
      .where((v) => !v.contains('-'))
      .toList();
  if (stable.isEmpty) return null;
  stable.sort(_compareVersions);
  return stable.last;
}

/// Distinct `tom_*` packages in the cache — the sensitivity a pass depends on.
int _cachedTomPackages() {
  final dir = _hostedCache;
  if (!dir.existsSync()) return 0;
  final names = <String>{};
  for (final entry in dir.listSync().whereType<Directory>()) {
    final n = entry.path.split(Platform.pathSeparator).last;
    final dash = n.lastIndexOf('-');
    if (n.startsWith(_ownedPrefix) && dash > 0) names.add(n.substring(0, dash));
  }
  return names.length;
}

/// Dependencies [package]'s pubspec declares with a `path:` key.
Set<String> _declaredPathDependencies(Directory package) {
  final keyPattern = RegExp(r'^(\s+)([A-Za-z0-9_]+):\s*$');
  final declared = <String>{};
  String? openKey;
  var openIndent = 0;
  for (final raw in File('${package.path}/pubspec.yaml').readAsLinesSync()) {
    final line = raw.split('#').first;
    if (line.trim().isEmpty) continue;
    final indent = line.length - line.trimLeft().length;
    if (openKey != null) {
      if (indent > openIndent) {
        if (line.trimLeft().startsWith('path:')) declared.add(openKey);
        continue;
      }
      openKey = null;
    }
    if (keyPattern.firstMatch(line) case final m?) {
      openKey = m.group(2);
      openIndent = m.group(1)!.length;
    }
  }
  return declared;
}

/// The constraints [package] declares on [names] (plain-string form only; a
/// `path:` or `git:` block is not a floor and is skipped).
Map<String, String> _declaredConstraints(Directory package, Set<String> names) {
  final sectionPattern = RegExp(r'^([A-Za-z_]+):');
  final depPattern = RegExp(r'''^  ([A-Za-z0-9_]+):\s*(.*)$''');
  final declared = <String, String>{};
  String? section;
  for (final line in File('${package.path}/pubspec.yaml').readAsLinesSync()) {
    if (sectionPattern.firstMatch(line) case final m?) {
      section = m.group(1);
      continue;
    }
    if (section != 'dependencies' && section != 'dev_dependencies') continue;
    final m = depPattern.firstMatch(line);
    if (m == null || !names.contains(m.group(1))) continue;
    final constraint = m
        .group(2)!
        .split('#')
        .first
        .trim()
        .replaceAll('"', '')
        .replaceAll("'", '');
    if (constraint.isEmpty) continue;
    declared[m.group(1)!] = constraint;
  }
  return declared;
}

/// The lower bound of a pub [constraint], or null when it has none.
String? _lowerBound(String constraint) {
  final c = constraint.trim();
  final caret = RegExp(r'^\^(\S+)').firstMatch(c);
  if (caret != null) return caret.group(1);
  final atLeast = RegExp(r'>=?\s*([0-9][^\s<]*)').firstMatch(c);
  if (atLeast != null) return atLeast.group(1);
  if (RegExp(r'^[0-9]+\.[0-9]+\.[0-9]+').hasMatch(c)) return c;
  return null;
}

bool _isCopySurface(String rel) => rel.split('/').contains('example');

void main() {
  final root = _repoRoot();

  group('frozen locks: what a package RESOLVES matches what it DECLARES', () {
    late List<Directory> packages;
    late int cachedPackages;

    setUpAll(() {
      packages = root == null ? const [] : _packagesUnder(root);
      cachedPackages = _cachedTomPackages();
      // ignore: avoid_print
      print(
        '[frozen-locks] pub-cache sensitivity on this machine: '
        '$cachedPackages distinct tom_* packages cached. A pass below is a '
        'statement about THIS machine: the guard can only see a freeze whose '
        'newer version is already cached here.',
      );
    });

    bool canDiscriminate(String caseName) {
      if (cachedPackages >= _minimumCachedPackages) return true;
      markTestSkipped(
        '$caseName cannot answer on this machine: its pub cache holds '
        '$cachedPackages distinct tom_* package(s), below the '
        '$_minimumCachedPackages needed to tell a frozen lock from a current '
        'one. Run `dart pub get` across the repo and re-run.',
      );
      return false;
    }

    test('F-VSC-LOCK-0: the walk finds the repo, the bridge and every sample '
        '[2026-10-02]', () {
      expect(root, isNotNull, reason: 'tom_vscode repo root not found');
      final rels = packages.map((p) => _relativeTo(root!, p)).toSet();
      // A walk that finds nothing reports every lock fresh — the exact shape of
      // the failure this file exists to catch. Name what it must find.
      expect(
        rels,
        containsAll(['tom_vscode_bridge', ..._knownSamples]),
        reason:
            'the walk missed packages it must cover (found: ${rels.join(', ')}). '
            'Only packages with a pubspec.lock are walked — run `dart pub get` '
            'in any that is missing.',
      );
    });

    test('F-VSC-LOCK-1: no undeclared path resolution [2026-10-02]', () {
      if (root == null) return markTestSkipped('repo root not reachable');
      final offenders = <String>[];
      for (final package in packages) {
        if (File('${package.path}/pubspec_overrides.yaml').existsSync()) {
          continue;
        }
        final declared = _declaredPathDependencies(package);
        for (final res in _lockedTomPackages(package)) {
          if (res.source == 'path' && !declared.contains(res.name)) {
            offenders.add(
              '${_relativeTo(root, package)} resolves ${res.name} from path '
              '(${res.version}) but declares no path dependency on it',
            );
          }
        }
      }
      expect(
        offenders,
        isEmpty,
        reason:
            'These packages test against a local working tree while their '
            'pubspec advertises a published version. Run `dart pub get` in '
            'each — pub discards a path resolution the pubspec no longer '
            'declares, but only when someone runs it.\n${offenders.join('\n')}',
      );
    });

    test('F-VSC-LOCK-2: no lock is behind a version already in the pub cache '
        '[2026-10-02]', () {
      if (root == null) return markTestSkipped('repo root not reachable');
      if (!canDiscriminate('F-VSC-LOCK-2')) return;
      final offenders = <String>[];
      for (final package in packages) {
        final rel = _relativeTo(root, package);
        if (_frozenLockExceptions.containsKey(rel.split('/').first)) continue;
        for (final res in _lockedTomPackages(package)) {
          if (res.source != 'hosted') continue;
          final newest = _newestCachedVersion(res.name);
          if (newest != null && _compareVersions(res.version, newest) < 0) {
            offenders.add(
              '$rel locks ${res.name} ${res.version} while $newest is already '
              'in the pub cache',
            );
          }
        }
      }
      expect(
        offenders,
        isEmpty,
        reason:
            '`pub get` is lock-preserving, so a lower-bound constraint admits a '
            'newer version without ever selecting it.\n'
            'REMEDY: `dart pub upgrade` in each package below (the samples are '
            'nested packages with their own locks). If a version does not '
            'move, a constraint holds it (raise it) or the sibling has '
            'unpublished work (publish it).\n${offenders.join('\n')}',
      );
    });

    test('F-VSC-LOCK-3: every exception is still load-bearing [2026-10-02]', () {
      if (root == null) return markTestSkipped('repo root not reachable');
      // Measured with NO exceptions applied: the question is which packages
      // are still frozen, which the exception list would filter out.
      final stillFrozen = <String>{};
      for (final package in packages) {
        for (final res in _lockedTomPackages(package)) {
          if (res.source != 'hosted') continue;
          final newest = _newestCachedVersion(res.name);
          if (newest != null && _compareVersions(res.version, newest) < 0) {
            stillFrozen.add(_relativeTo(root, package).split('/').first);
          }
        }
      }
      final obsolete = _frozenLockExceptions.keys.toSet().difference(
        stillFrozen,
      );
      expect(
        obsolete,
        isEmpty,
        reason:
            'Exempted from F-VSC-LOCK-2 but no longer frozen — the exemption '
            'now only grants the right to freeze again unnoticed. Delete: '
            '${obsolete.join(', ')}',
      );
    });

    test('F-VSC-LOCK-4: no sample declares a floor below a version already in '
        'the pub cache [2026-10-02]', () {
      if (root == null) return markTestSkipped('repo root not reachable');
      if (!canDiscriminate('F-VSC-LOCK-4')) return;
      final surfaces = _packagesUnder(root, withLock: false)
          .where((p) => _isCopySurface(_relativeTo(root, p)))
          .toList();
      expect(
        surfaces.map((p) => _relativeTo(root, p)),
        containsAll(_knownSamples),
        reason: 'the copy-surface discovery found too little to be trusted',
      );
      // Guards the guard: a parser that reads nothing reports every sample
      // clean. Every known sample declares the demonstrated package.
      for (final rel in _knownSamples) {
        final sample = surfaces.firstWhere((p) => _relativeTo(root, p) == rel);
        expect(
          _declaredConstraints(sample, _demonstratedPackages),
          contains('tom_vscode_scripting_api'),
          reason: 'the pubspec scan read no constraint in $rel',
        );
      }

      final offenders = <String>[];
      for (final package in surfaces) {
        final declared = _declaredConstraints(package, _demonstratedPackages);
        for (final MapEntry(key: name, value: constraint) in declared.entries) {
          final floor = _lowerBound(constraint);
          final newest = _newestCachedVersion(name);
          final rel = _relativeTo(root, package);
          if (floor == null) {
            offenders.add('$rel declares $name "$constraint" — no floor');
          } else if (newest != null && _compareVersions(floor, newest) < 0) {
            offenders.add(
              '$rel declares $name "$constraint" while $newest is already in '
              'the pub cache',
            );
          }
        }
      }
      expect(
        offenders,
        isEmpty,
        reason:
            'A sample is what a new project copies, so its floor should name '
            'the release it is run against: the current one.\n'
            'REMEDY: raise the floor to the newest published version, '
            '`dart pub upgrade` in the sample, and run it against a VS Code '
            'window (`dart run bin/run_example.dart <concept>`). If it no '
            'longer works, that is the bug — fix the sample, do not lower the '
            'floor.\n${offenders.join('\n')}',
      );
    });
  });
}
