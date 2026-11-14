// Gives the web modules (web/js/marks.js and friends) the test team, the way /api/bootstrap does in the app.
// Import it before anything from web/js in a test file.
import { MEMBERS, TEAM_VIEW, DEFAULT_RESPONDER } from '../../server/team.mjs';
import { setTeam } from '../../web/js/marks.js';

setTeam({ members: MEMBERS, team: { ...TEAM_VIEW, lead: DEFAULT_RESPONDER } });
