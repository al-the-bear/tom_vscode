/// Round-trip tests for the caller-controlled Agent SDK config surface:
/// `Options` and its sealed sub-configs, the permission/MCP value types, and
/// the enums. These travel Dart → extension → `sdk.query()`, so the contract is
/// `T.fromJson(t.toJson()).toJson() == t.toJson()` plus correct wire field
/// names (camelCase on Options, matching `sdk.d.ts` ^0.2.110).
library;

import 'package:tom_vscode_scripting_api/tom_vscode_scripting_api.dart';
import 'package:test/test.dart';

void main() {
  group('enums map to their SDK wire strings', () {
    test('PermissionMode covers all six SDK values', () {
      expect(PermissionMode.default_.wire, 'default');
      expect(PermissionMode.acceptEdits.wire, 'acceptEdits');
      expect(PermissionMode.bypassPermissions.wire, 'bypassPermissions');
      expect(PermissionMode.plan.wire, 'plan');
      expect(PermissionMode.dontAsk.wire, 'dontAsk');
      expect(PermissionMode.auto.wire, 'auto');
      for (final m in PermissionMode.values) {
        expect(PermissionMode.fromWire(m.wire), m);
      }
    });

    test('SettingSource and EffortLevel round-trip', () {
      for (final s in SettingSource.values) {
        expect(SettingSource.fromWire(s.wire), s);
      }
      expect(EffortLevel.xhigh.wire, 'xhigh');
      for (final e in EffortLevel.values) {
        expect(EffortLevel.fromWire(e.wire), e);
      }
    });

    test('PermissionDecisionClassification uses snake_case wire', () {
      expect(
        PermissionDecisionClassification.userTemporary.wire,
        'user_temporary',
      );
      expect(
        PermissionDecisionClassification.userReject.wire,
        'user_reject',
      );
    });
  });

  group('sealed config sub-types round-trip via toWire/fromWire', () {
    test('SystemPrompt: text / list / preset', () {
      expect(SystemPrompt.fromWire('hi').toWire(), 'hi');
      expect(
        SystemPrompt.fromWire(['a', 'b']).toWire(),
        ['a', 'b'],
      );
      final preset = SystemPrompt.fromWire({
        'type': 'preset',
        'preset': 'claude_code',
        'append': 'extra',
        'excludeDynamicSections': true,
      });
      expect(preset, isA<SystemPromptPreset>());
      expect((preset as SystemPromptPreset).append, 'extra');
      expect(preset.toWire(), {
        'type': 'preset',
        'preset': 'claude_code',
        'append': 'extra',
        'excludeDynamicSections': true,
      });
    });

    test('ToolsConfig: list / claude_code preset', () {
      expect(ToolsConfig.fromWire(['Read']).toWire(), ['Read']);
      final preset = ToolsConfig.fromWire({
        'type': 'preset',
        'preset': 'claude_code',
      });
      expect(preset, isA<ToolsClaudeCodePreset>());
      expect(preset.toWire(), {'type': 'preset', 'preset': 'claude_code'});
    });

    test('ThinkingConfig: adaptive / enabled / disabled', () {
      expect(
        ThinkingConfig.fromWire({'type': 'adaptive'}).toWire(),
        {'type': 'adaptive'},
      );
      final enabled = ThinkingConfig.fromWire({
        'type': 'enabled',
        'budgetTokens': 4096,
      });
      expect(enabled, isA<ThinkingEnabled>());
      expect(enabled.toWire(), {'type': 'enabled', 'budgetTokens': 4096});
      expect(
        ThinkingConfig.fromWire({'type': 'disabled'}).toWire(),
        {'type': 'disabled'},
      );
    });

    test('Skills: list / all', () {
      expect(Skills.fromWire(['x']).toWire(), ['x']);
      expect(Skills.fromWire('all').toWire(), 'all');
    });
  });

  group('permission value types round-trip', () {
    test('PermissionResult allow with updatedInput', () {
      final allow = PermissionAllow(
        updatedInput: {'path': '/safe'},
        decisionClassification:
            PermissionDecisionClassification.userPermanent,
      );
      final wire = allow.toJson();
      expect(wire['behavior'], 'allow');
      expect(wire['updatedInput'], {'path': '/safe'});
      expect(wire['decisionClassification'], 'user_permanent');
      final back = PermissionResult.fromJson(wire);
      expect(back, isA<PermissionAllow>());
      expect(back.toJson(), equals(wire));
    });

    test('PermissionResult deny with message + interrupt', () {
      final deny = PermissionDeny(message: 'no', interrupt: true);
      final wire = deny.toJson();
      expect(wire['behavior'], 'deny');
      expect(wire['message'], 'no');
      expect(wire['interrupt'], true);
      final back = PermissionResult.fromJson(wire);
      expect(back, isA<PermissionDeny>());
      expect(back.toJson(), equals(wire));
    });

    test('PermissionUpdate variants round-trip', () {
      final addRules = PermissionUpdate.fromJson({
        'type': 'addRules',
        'rules': [
          {'toolName': 'Bash', 'ruleContent': 'ls'},
        ],
        'behavior': 'allow',
        'destination': 'session',
      });
      expect(addRules.toJson(), {
        'type': 'addRules',
        'rules': [
          {'toolName': 'Bash', 'ruleContent': 'ls'},
        ],
        'behavior': 'allow',
        'destination': 'session',
      });

      final setMode = PermissionUpdate.fromJson({
        'type': 'setMode',
        'mode': 'plan',
        'destination': 'cliArg',
      });
      expect(setMode.toJson(), {
        'type': 'setMode',
        'mode': 'plan',
        'destination': 'cliArg',
      });
    });
  });

  group('MCP config + tool descriptors round-trip', () {
    test('stdio / sse / http server configs', () {
      final stdio = McpServerConfig.fromJson({
        'type': 'stdio',
        'command': 'node',
        'args': ['server.js'],
        'env': {'K': 'V'},
      });
      expect(stdio, isA<McpStdioServerConfig>());
      expect(stdio.toJson(), {
        'type': 'stdio',
        'command': 'node',
        'args': ['server.js'],
        'env': {'K': 'V'},
      });

      final sse = McpServerConfig.fromJson({
        'type': 'sse',
        'url': 'https://x/sse',
        'headers': {'Authorization': 'Bearer t'},
      });
      expect(sse, isA<McpSSEServerConfig>());
      expect(sse.toJson(), {
        'type': 'sse',
        'url': 'https://x/sse',
        'headers': {'Authorization': 'Bearer t'},
      });

      final http = McpServerConfig.fromJson({
        'type': 'http',
        'url': 'https://x/mcp',
        'alwaysLoad': true,
      });
      expect(http, isA<McpHttpServerConfig>());
      expect(http.toJson(), {
        'type': 'http',
        'url': 'https://x/mcp',
        'alwaysLoad': true,
      });
    });

    test('sdk server config carries the descriptor (name/version/tools)', () {
      final tool = SdkMcpTool(
        name: 'greet',
        description: 'Say hi',
        inputSchema: {
          'type': 'object',
          'properties': {
            'who': {'type': 'string'},
          },
        },
      );
      final cfg = McpSdkServerConfig(
        name: 'my-tools',
        version: '1.0.0',
        tools: [tool],
      );
      final wire = cfg.toJson();
      expect(wire['type'], 'sdk');
      expect(wire['name'], 'my-tools');
      expect(wire['version'], '1.0.0');
      expect((wire['tools'] as List).single, {
        'name': 'greet',
        'description': 'Say hi',
        'inputSchema': {
          'type': 'object',
          'properties': {
            'who': {'type': 'string'},
          },
        },
      });
      final back = McpServerConfig.fromJson(wire);
      expect(back, isA<McpSdkServerConfig>());
      expect(back.toJson(), equals(wire));
    });

    test('CallToolResult.text builds an MCP content payload', () {
      final r = CallToolResult.text('hello');
      expect(r.toJson(), {
        'content': [
          {'type': 'text', 'text': 'hello'},
        ],
      });
      final back = CallToolResult.fromJson(r.toJson());
      expect(back.toJson(), equals(r.toJson()));
    });
  });

  group('Options round-trips its data (tier-C) fields', () {
    test('rich Options instance survives toJson → fromJson → toJson', () {
      final o = Options(
        model: 'claude-x',
        fallbackModel: 'claude-y',
        systemPrompt: SystemPromptPreset(append: 'be terse'),
        tools: ToolsClaudeCodePreset(),
        allowedTools: ['Read', 'Edit'],
        disallowedTools: ['Bash'],
        mcpServers: {
          'srv': McpStdioServerConfig(command: 'node'),
        },
        maxTurns: 12,
        maxBudgetUsd: 1.5,
        permissionMode: PermissionMode.acceptEdits,
        settingSources: [SettingSource.project, SettingSource.local],
        cwd: '/work',
        additionalDirectories: ['/extra'],
        resume: 'sess-1',
        env: {'FOO': 'bar'},
        thinking: ThinkingEnabled(budgetTokens: 2048),
        effort: EffortLevel.high,
        includePartialMessages: true,
        betas: ['context-1m-2025-08-07'],
      );

      final wire = o.toJson();
      expect(wire['model'], 'claude-x');
      expect(wire['permissionMode'], 'acceptEdits');
      expect(wire['settingSources'], ['project', 'local']);
      expect(wire['maxTurns'], 12);
      expect(wire['systemPrompt'], {
        'type': 'preset',
        'preset': 'claude_code',
        'append': 'be terse',
      });
      expect(wire['tools'], {'type': 'preset', 'preset': 'claude_code'});
      expect(wire['mcpServers'], {
        'srv': {'type': 'stdio', 'command': 'node'},
      });
      expect(wire['thinking'], {'type': 'enabled', 'budgetTokens': 2048});

      final back = Options.fromJson(wire);
      expect(back.toJson(), equals(wire));
    });

    test('empty Options serializes to an empty map (no null keys)', () {
      expect(Options().toJson(), <String, dynamic>{});
    });

    test('callback fields are not part of the JSON wire data', () {
      final o = Options(
        model: 'claude-x',
        canUseTool: (name, input, ctx) async => PermissionAllow(),
        onStderr: (line) {},
      );
      expect(o.toJson().containsKey('canUseTool'), isFalse);
      expect(o.toJson().containsKey('stderr'), isFalse);
      expect(o.canUseTool, isNotNull);
    });
  });
}
