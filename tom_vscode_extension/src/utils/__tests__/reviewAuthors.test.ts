/**
 * Who wrote a review annotation (src/utils/reviewAuthors.ts).
 *
 *   RV-1 agentAuthorId: `agent_<role>`, the role lower-cased to `[a-z0-9_]` (a member id the runtime takes);
 *        `agent` without a role
 *   RV-2 isAgentAuthor: `agent`, `agent_<role>` and a hand-written `agent:<role>`; nothing else
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { CHECK_HERE_MARKER, agentAuthorId, isAgentAuthor } from '../reviewAuthors';

describe('review authors', () => {
    test('RV-1: agentAuthorId', () => {
        assert.equal(agentAuthorId('spec_author'), 'agent_spec_author');
        assert.equal(agentAuthorId('Software Engineer'), 'agent_software_engineer');
        assert.equal(agentAuthorId(' -Reviewer- '), 'agent_reviewer');
        assert.equal(agentAuthorId(''), 'agent');
        assert.equal(agentAuthorId(undefined), 'agent');
        for (const id of ['agent_spec_author', 'agent_software_engineer', 'agent']) { assert.match(id, /^[a-z0-9_]+$/, 'a review member id'); }
    });

    test('RV-2: isAgentAuthor', () => {
        assert.deepEqual(['agent', 'agent_spec_author', 'agent:reviewer', 'Agent_X'].map(isAgentAuthor), [true, true, true, true]);
        assert.deepEqual(['agentur', 'alice', '', null, undefined].map(isAgentAuthor), [false, false, false, false, false]);
        assert.equal(CHECK_HERE_MARKER, '___check here___');
    });
});
