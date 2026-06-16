/// Concept: inspect timed / scheduled requests (read-only).
///
/// Run:  dart run bin/run_example.dart timed_requests
///
/// `TomTimedApi` is full control of the timer engine — create interval or
/// clock-scheduled prompts, enable/disable them, and turn the engine on or off.
/// This concept only *reads*: it reports the entry counts and whether the timer
/// engine is currently activated, so it never schedules or fires a real prompt.
/// The mutating operations (`create`, `update`, `enable`, `activateTimer`, …)
/// are the same API surface, used the same way.
///
/// Expected output:
///   Timed requests: 3 entries (2 active, 1 paused). Timer engine: on.
///   First entry: interval every 30 min — "Summarise open PRs…"
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';

/// Concept body: set the adapter, read the entries and the engine state.
Future<bool> runTimedRequestsExample(VSCodeAdapter adapter) async {
  TomTimedApi.setAdapter(adapter);

  final result = await TomTimedApi.list();
  final activated = await TomTimedApi.isTimerActivated();
  print(
    'Timed requests: ${result.totalCount} entries '
    '(${result.activeCount} active, ${result.pausedCount} paused). '
    'Timer engine: ${activated ? 'on' : 'off'}.',
  );

  if (result.entries.isEmpty) {
    print('First entry: <none>');
  } else {
    final first = result.entries.first;
    print('First entry: ${_schedule(first)} — "${_preview(first.originalText)}"');
  }

  return true;
}

/// Human-readable one-liner for an entry's schedule.
String _schedule(TimedRequest entry) {
  switch (entry.scheduleMode) {
    case ScheduleMode.interval:
      final minutes = entry.intervalMinutes;
      return minutes == null
          ? 'interval (unset)'
          : 'interval every $minutes min';
    case ScheduleMode.scheduled:
      final times = entry.scheduledTimes ?? const [];
      final at = times.map((t) => t.time).join(', ');
      return at.isEmpty ? 'scheduled (no times)' : 'scheduled at $at';
  }
}

/// First line of [text], trimmed to ~40 chars with an ellipsis.
String _preview(String text) {
  final firstLine = text.split('\n').first.trim();
  return firstLine.length <= 40 ? firstLine : '${firstLine.substring(0, 40)}…';
}
