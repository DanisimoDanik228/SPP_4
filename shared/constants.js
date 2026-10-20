'use strict';

var CONST = {
  TICK_MS: 1000 / 30,
  WORLD: { w: 1600, h: 900 },

  PLAYER_R: 18,
  PLAYER_SPEED: 260,
  PLAYER_HP: 100,
  RESPAWN_TICKS: 60,

  SHOT_SPEED: 720,
  SHOT_R: 4,
  SHOT_TTL_TICKS: 33,
  SHOT_COOLDOWN_TICKS: 8,
  SHOT_DMG: 25,

  ORB_R: 9,
  ORB_VALUE: 10,
  ORB_TARGET: 45,

  KILL_BONUS: 50,
  MAX_PLAYERS: 16,

  INTERP_DELAY: 100,
  SAVE_MS: 5000,
  LB_TICKS: 15,
  DATA_FILE: 'data/save.json'
};

if (typeof module !== 'undefined' && module.exports) module.exports = CONST;
if (typeof window !== 'undefined') window.CONST = CONST;
