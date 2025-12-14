const fs = require("fs");
const yaml = require("js-yaml");

/* ================= LOAD STRATEGY ================= */

const strategy = yaml.load(fs.readFileSync("config/strategy.yaml", "utf8"));
const opponent = yaml.load(fs.readFileSync("config/opponent.yaml", "utf8"));

/* ================= LOAD SCENARIO FROM CLI ================= */

let scenario = null;
const scenarioPath = process.argv[2];

if (scenarioPath) {
  if (!fs.existsSync(scenarioPath)) {
    console.error("Scenario file not found:", scenarioPath);
    process.exit(1);
  }
  scenario = yaml.load(fs.readFileSync(scenarioPath, "utf8")).scenario;
  console.log("Loaded scenario:", scenarioPath);
} else {
  console.log("No scenario provided — default Monte Carlo mode");
}

/* ================= HAND COUNT ================= */

function isFullyFixed(s) {
  return s &&
    s.hero_cards &&
    s.opponent_cards &&
    s.board &&
    s.board.flop &&
    s.board.turn &&
    s.board.river;
}

const HANDS = isFullyFixed(scenario)
  ? 1
  : (scenario && scenario.repeats ? scenario.repeats : 50000);

/* ================= CONFIG ================= */

const START_POT = 20;

const BET_SIZES = {
  SMALL: 0.33,
  MEDIUM: 0.66,
  BIG: 1.0,
  OVERBET: 1.5
};

/* ================= LOGGING ================= */

const logStream = fs.createWriteStream("/tmp/hands.log");
let loggedHands = 0;

function log(t) {
  if (loggedHands < 200) logStream.write(t + "\n");
}

/* ================= CARD ENGINE ================= */

const SUITS = ["h", "d", "c", "s"];
const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];

function buildDeck() {
  const d = [];
  for (const r of RANKS)
    for (const s of SUITS)
      d.push(r + s);
  return d;
}

function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
}

function deal(d, n) {
  return d.splice(0, n);
}

function removeCards(d, cards) {
  cards.forEach(c => {
    const i = d.indexOf(c);
    if (i !== -1) d.splice(i, 1);
  });
}

/* ================= HAND BUCKET ================= */

function classifyHand(hole, board) {
  const cards = hole.concat(board);
  const ranks = cards.map(c => c[0]);
  const suits = cards.map(c => c[1]);

  const rc = {};
  const sc = {};

  ranks.forEach(r => rc[r] = (rc[r] || 0) + 1);
  suits.forEach(s => sc[s] = (sc[s] || 0) + 1);

  if (Object.values(rc).some(v => v >= 3)) return "MONSTER";
  if (Object.values(sc).some(v => v >= 5)) return "MONSTER";
  if (Object.values(rc).some(v => v === 2)) return "STRONG";
  if (Object.values(sc).some(v => v === 4)) return "DRAW";
  return "AIR";
}

/* ================= STRATEGY ================= */

function parseAction(node) {
  if (!node) return { action: "CHECK" };
  if (typeof node === "string") return { action: node };
  return node;
}

function requireBetSize(act) {
  if (!act.size || !BET_SIZES[act.size]) {
    throw new Error(`BET missing valid size: ${JSON.stringify(act)}`);
  }
}

/* ================= OPPONENT (LEGAL ACTIONS ONLY) ================= */

const R = () => Math.random();

function oppFlop(heroAction) {
  if (heroAction === "CHECK")
    return R() < opponent.lag.flop.vs_check_bet_freq ? "BET" : "CHECK";
  return R() < opponent.lag.flop.vs_bet_call_freq ? "CALL" : "FOLD";
}

function oppTurn(heroBet) {
  if (heroBet)
    return R() < opponent.lag.turn.barrel_freq ? "CALL" : "FOLD";
  return R() < opponent.lag.turn.barrel_freq ? "BET" : "CHECK";
}

function oppRiver(heroBet) {
  if (heroBet)
    return R() < opponent.lag.river.call_freq ? "CALL" : "FOLD";
  return R() < opponent.lag.river.bluff_freq ? "BET" : "CHECK";
}

/* ================= SIMULATION ================= */

let EV = 0;

for (let i = 0; i < HANDS; i++) {
  loggedHands++;
  let pot = START_POT;
  let handEV = 0;
  let handOver = false;

  const deck = buildDeck();

  if (scenario && scenario.hero_cards) removeCards(deck, scenario.hero_cards);
  if (scenario && scenario.opponent_cards) removeCards(deck, scenario.opponent_cards);
  if (scenario && scenario.board && scenario.board.flop) removeCards(deck, scenario.board.flop);
  if (scenario && scenario.board && scenario.board.turn) removeCards(deck, scenario.board.turn);
  if (scenario && scenario.board && scenario.board.river) removeCards(deck, scenario.board.river);

  shuffle(deck);

  const hero = scenario && scenario.hero_cards ? scenario.hero_cards : deal(deck, 2);
  const opp = scenario && scenario.opponent_cards ? scenario.opponent_cards : deal(deck, 2);
  const flop = scenario && scenario.board && scenario.board.flop ? scenario.board.flop : deal(deck, 3);
  const turn = scenario && scenario.board && scenario.board.turn ? scenario.board.turn : deal(deck, 1);
  const river = scenario && scenario.board && scenario.board.river ? scenario.board.river : deal(deck, 1);

  log(`Hand #${i + 1}`);
  log(`Hero: ${hero.join(" ")}`);
  log(`Villain: ${opp.join(" ")}`);
  log(`Board: ${flop.join(" ")} | ${turn[0]} | ${river[0]}`);
  log(`Pot: ${pot}`);

  /* ===== FLOP ===== */
  const fBucket = classifyHand(hero, flop);
  const fAct = parseAction(strategy.hero.flop.heads_up[fBucket]);
  const oF = oppFlop(fAct.action);

  if (fAct.action === "BET") {
    requireBetSize(fAct);
    const b = pot * BET_SIZES[fAct.size];
    pot += b;
    handEV -= b;
    log(`FLOP: Hero BET ${b.toFixed(1)} (${fAct.size})`);
  } else {
    log(`FLOP: Hero CHECK`);
  }

  log(`FLOP: Opponent ${oF}`);

  if (oF === "FOLD") {
    handEV += pot;
    EV += handEV;
    log(`Result: Hero wins ${pot}`);
    log("-----");
    continue;
  }

  /* ===== TURN ===== */
  const tBucket = classifyHand(hero, flop.concat(turn));
  const tAct = parseAction(strategy.hero.turn.after_bet[tBucket]);
  const oT = oppTurn(tAct.action === "BET");

  if (tAct.action === "BET") {
    requireBetSize(tAct);
    const b = pot * BET_SIZES[tAct.size];
    pot += b;
    handEV -= b;
    log(`TURN: Hero BET ${b.toFixed(1)} (${tAct.size})`);
  } else {
    log(`TURN: Hero CHECK`);
  }

  log(`TURN: Opponent ${oT}`);

  if (oT === "FOLD") {
    handEV += pot;
    EV += handEV;
    log(`Result: Hero wins ${pot}`);
    log("-----");
    continue;
  }

  /* ===== RIVER ===== */
  const rBucket = classifyHand(hero, flop.concat(turn, river));
  const oR = oppRiver(false);
  const rNode = oR === "BET"
    ? strategy.hero.river.facing_bet[rBucket]
    : strategy.hero.river.value[rBucket];
  const rAct = parseAction(rNode);

  log(`RIVER: Opponent ${oR}`);

  if (rAct.action === "BET") {
    requireBetSize(rAct);
    const b = pot * BET_SIZES[rAct.size];
    pot += b;
    handEV -= b;
    log(`RIVER: Hero BET ${b.toFixed(1)} (${rAct.size})`);
  } else if (rAct.action === "CALL") {
    const c = pot * 0.5;
    pot += c;
    handEV -= c;
    log(`RIVER: Hero CALL ${c.toFixed(1)}`);
  } else {
    log(`RIVER: Hero CHECK/FOLD`);
  }

  if (rBucket === "MONSTER") handEV += pot;

  EV += handEV;
  log(`Result: Hero EV ${handEV.toFixed(1)}`);
  log("-----");
}

/* ================= OUTPUT ================= */

logStream.end();

console.log("Hands:", HANDS);
console.log("Total EV:", EV.toFixed(2));
console.log("EV / hand:", (EV / HANDS).toFixed(4));
