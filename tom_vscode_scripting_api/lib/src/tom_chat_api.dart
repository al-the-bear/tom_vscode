/// Tom Chat API for scripting access to the "Send to Chat" transport.
///
/// Sends a prompt to whichever chat transport the extension is configured to
/// use (`sendToChatTarget`: `anthropic` or `copilot`, default `anthropic`) and
/// returns the answer. The behaviour a script sees is identical for both
/// targets — an answer comes back either way:
///
/// - **anthropic** — the prompt is handled exactly as if typed into the
///   Anthropic chat panel (active profile, its configuration, the default
///   user-message template, the full tool loop). The answer is the Anthropic
///   transport's response text. A second concurrent send is **rejected**
///   (see [SendToChatResult.rejected]).
/// - **copilot** — the prompt is sent to Copilot Chat and the answer is read
///   back via the answer-file round-trip (`tomAi_askCopilot`).
// ignore_for_file: avoid_classes_with_only_static_members
library;

import 'vscode_adapter.dart';

// ============================================================================
// Types
// ============================================================================

/// The outcome of a [TomChatApi.sendToChat] call.
class SendToChatResult {
  /// Which transport handled the prompt (`anthropic` or `copilot`).
  final String target;

  /// Whether the prompt was dispatched and (for anthropic) answered.
  final bool success;

  /// The transport's answer text (empty when none was produced).
  final String answer;

  /// True when an Anthropic turn was already running and this send was
  /// rejected without starting (the prompt queue owns queuing, not this API).
  final bool rejected;

  /// Failure reason when [success] is false; empty otherwise.
  final String error;

  SendToChatResult({
    required this.target,
    required this.success,
    required this.answer,
    required this.rejected,
    required this.error,
  });

  factory SendToChatResult.fromJson(Map<String, dynamic> json) {
    return SendToChatResult(
      target: json['target'] as String? ?? 'anthropic',
      success: json['success'] as bool? ?? false,
      answer: json['answer'] as String? ?? '',
      rejected: json['rejected'] as bool? ?? false,
      error: json['error'] as String? ?? '',
    );
  }
}

// ============================================================================
// API
// ============================================================================

/// Scripting access to the Tom extension's "Send to Chat" transport.
///
/// All methods throw [StateError] when the adapter has not been set.
abstract class TomChatApi {
  static VSCodeAdapter? _adapter;

  /// Set the adapter for API calls.
  static void setAdapter(VSCodeAdapter adapter) {
    _adapter = adapter;
  }

  static VSCodeAdapter get _requireAdapter {
    if (_adapter == null) {
      throw StateError('TomChatApi: adapter not set. Call setAdapter() first.');
    }
    return _adapter!;
  }

  /// Send [prompt] to the configured chat target and return the answer.
  ///
  /// The returned [SendToChatResult] reports the resolved [target], the
  /// [answer], and whether the send was [SendToChatResult.rejected] because an
  /// Anthropic turn was already in flight.
  static Future<SendToChatResult> sendToChat(String prompt) async {
    final result = await _requireAdapter.sendRequest('sendToChatVce', {
      'prompt': prompt,
    });
    return SendToChatResult.fromJson(result);
  }
}
