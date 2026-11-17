import type { SampleAccountDef, SampleCategoryDef, SampleDataset, SampleTx } from "./sampleData.js";

// Extended demo dataset: three full years of history ending today, for
// trying multi-month and multi-year reports. Not the default (a few thousand
// rows is more than a new ledger needs to look around); it is opt-in from
// onboarding, Settings, and the --sample-data launch flag.
//
// Everything is synthetic. It has a story so year-over-year views have
// something to show:
//   - pay rises every January and a bonus every March;
//   - rent goes up every August;
//   - utilities peak in winter and summer;
//   - a gym membership starts and is cancelled, and a streaming price rises;
//   - a car is bought in year two: transit drops, fuel/insurance/service start;
//   - a summer trip every year (one in EUR), a ski trip one winter;
//   - holiday shopping every November–December;
//   - taxes: refund, then a balance due, then a refund;
//   - one reimbursed work expense marked "exclude from reports".
// Card spending is paid off in full each month and checking surplus is swept
// into savings, so balances stay realistic over the whole span.
//
// Variation comes from a seeded PRNG, so the data is irregular but the same
// on every run for the same "today".

const YEARS = 3;

const ACCOUNTS: SampleAccountDef[] = [
  { name: "Everyday Checking", account_type: "Checking", liquidity_type: "Liquid", base_currency: "USD", exchange_rate: 1, opening: 450000 },
  { name: "Household Savings", account_type: "Savings", liquidity_type: "Liquid", base_currency: "USD", exchange_rate: 1, opening: 1500000 },
  { name: "Sapphire Card", account_type: "CC", liquidity_type: "Liquid", base_currency: "USD", exchange_rate: 1, opening: 0 },
  { name: "Euro Account", account_type: "Checking", liquidity_type: "Liquid", base_currency: "EUR", exchange_rate: 1.08, opening: 150000 },
  { name: "TechCo RSUs", account_type: "RSU", liquidity_type: "Invested", base_currency: "USD", exchange_rate: 1, opening: 0, ticker: "TCO", shares_quantity: 240, current_price_usd: 5240 },
  { name: "Retirement 401k", account_type: "401k", liquidity_type: "Locked", base_currency: "USD", exchange_rate: 1, opening: 6200000 },
];

const CATEGORIES: SampleCategoryDef[] = [
  { name: "Salary", kind: "income" },
  { name: "Bonus", kind: "income" },
  { name: "Freelance", kind: "income" },
  { name: "Other Income", kind: "income" },
  { name: "Housing", children: ["Rent", "Utilities", "Internet"] },
  { name: "Food", children: ["Groceries", "Dining Out", "Coffee"] },
  { name: "Transport", children: ["Transit", "Fuel", "Car Insurance", "Car Service"] },
  { name: "Car" },
  { name: "Subscriptions" },
  { name: "Shopping" },
  { name: "Gifts" },
  { name: "Health", children: ["Pharmacy", "Dentist", "Gym"] },
  { name: "Travel" },
  { name: "Taxes", kind: "both" },
  { name: "Work Expenses" },
];

const CHECKING = "Everyday Checking";
const SAVINGS = "Household Savings";
const CARD = "Sapphire Card";
const EURO = "Euro Account";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(): SampleTx[] {
  const rand = mulberry32(20240901);
  const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo)); // cents
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const chance = (p: number) => rand() < p;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  // Start on the 1st of the month YEARS*12 months back: whole months only.
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - YEARS * 12, 1));
  const startYear = start.getUTCFullYear();

  const rows: SampleTx[] = [];
  const bal = new Map<string, number>(ACCOUNTS.map((a) => [a.name, a.opening]));
  const push = (t: SampleTx) => {
    rows.push(t);
    if (t.type === "transfer") {
      bal.set(t.account, bal.get(t.account)! - t.amount);
      bal.set(t.toAccount!, bal.get(t.toAccount!)! + t.amount);
    } else {
      bal.set(t.account, bal.get(t.account)! + (t.type === "credit" ? t.amount : -t.amount));
    }
  };
  const spend = (date: string, account: string, category: string, description: string, amount: number, extra: Partial<SampleTx> = {}) =>
    push({ date, account, category, description, amount, type: "debit", ...extra });
  const earn = (date: string, account: string, category: string, description: string, amount: number) =>
    push({ date, account, category, description, amount, type: "credit" });
  const move = (date: string, from: string, to: string, description: string, amount: number) =>
    push({ date, account: from, toAccount: to, category: null, description, amount, type: "transfer" });

  const summerTrips = [
    { city: "Lisbon", eur: true, air: "Atlantic Air", hotel: "Hotel Lisboa", food: ["Time Out Market", "Cervejaria Ramiro"] },
    { city: "Montreal", eur: false, air: "Northern Air", hotel: "Le Petit Hôtel", food: ["Schwartz's Deli", "Olive et Gourmando"] },
    { city: "Kyoto", eur: false, air: "Pacific Wings", hotel: "Gion Ryokan", food: ["Nishiki Market", "Ramen Sen"] },
    { city: "Barcelona", eur: true, air: "Atlantic Air", hotel: "Casa Gràcia", food: ["La Boqueria", "Bar Cañete"] },
  ];

  let monthIndex = -1;
  let carBought = false;
  for (let d = new Date(start); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const dom = d.getUTCDate();
    const month = d.getUTCMonth(); // 0-11
    const weekday = d.getUTCDay();
    const yearIdx = d.getUTCFullYear() - startYear;
    if (dom === 1) monthIndex++;
    const m = monthIndex; // months since start
    carBought = m >= 15;

    // ── Income ──────────────────────────────────────────────────────────────
    const salary = Math.round(345000 * Math.pow(1.045, yearIdx) / 100) * 100;
    if (dom === 1 || dom === 15) earn(date, CHECKING, "Salary", "TechCo payroll", salary);
    if (month === 2 && dom === 15) earn(date, CHECKING, "Bonus", "TechCo annual bonus", Math.round(600000 * (1 + 0.08 * yearIdx)));
    if (dom === 25 && m % 3 === 1) earn(date, EURO, "Freelance", "Design consulting (EU client)", between(55000, 90000));
    if (month === 3 && dom === 18) {
      if (yearIdx === 1) spend(date, CHECKING, "Taxes", "IRS -- balance due", 214000);
      else earn(date, CHECKING, "Taxes", "IRS -- tax refund", between(60000, 160000));
    }
    if (chance(0.006)) earn(date, CHECKING, "Other Income", pick(["Marketplace sale", "Cashback reward", "Returned deposit"]), between(4000, 30000));

    // ── Housing ─────────────────────────────────────────────────────────────
    const rentRaises = yearIdx + (month >= 7 ? 1 : 0); // each August
    if (dom === 1) spend(date, CHECKING, "Rent", "Apartment rent", 225000 + 9000 * rentRaises);
    if (dom === 5) {
      const seasonal = [1.45, 1.35, 1.1, 0.9, 0.85, 1.05, 1.35, 1.4, 1.05, 0.9, 1.05, 1.3][month];
      spend(date, CHECKING, "Utilities", "City Power & Water", Math.round(between(11000, 13500) * seasonal));
    }
    if (dom === 7) spend(date, CARD, "Internet", "FiberNet", m < 18 ? 6500 : 7500);

    // ── Subscriptions ───────────────────────────────────────────────────────
    if (dom === 3) spend(date, CARD, "Subscriptions", "Streamly", m < 20 ? 1599 : 1799);
    if (dom === 9) spend(date, CARD, "Subscriptions", "MusicNow", 1099);
    if (dom === 12) spend(date, CARD, "Subscriptions", "CloudBox", m < 12 ? 299 : 999);
    if (dom === 8) spend(date, EURO, "Subscriptions", "EU mobile plan", 4500);
    if (dom === 10 && m >= 9 && m <= 17) spend(date, CARD, "Gym", "PulseFit gym", 4900);

    // ── Food ────────────────────────────────────────────────────────────────
    const holiday = month === 10 || month === 11;
    if (weekday === 6) {
      spend(date, CARD, "Groceries", pick(["FreshMart", "Whole Grains Market", "Corner Grocer"]),
        Math.round(between(7500, 16000) * (holiday ? 1.3 : 1)));
    }
    if (weekday === 3 && chance(0.6)) spend(date, CARD, "Groceries", "FreshMart", between(1800, 5500));
    if (weekday === 5 || (weekday === 6 && chance(0.3))) {
      spend(date, CARD, "Dining Out", pick(["Nori Sushi", "La Taqueria", "Trattoria Nonna", "Saigon Kitchen", "The Burger Joint"]), between(2400, 9800));
    }
    if (weekday >= 1 && weekday <= 5 && chance(0.45)) spend(date, CARD, "Coffee", pick(["Corner Cafe", "Bean There"]), between(450, 900));

    // ── Transport ───────────────────────────────────────────────────────────
    if (!carBought && weekday === 1) spend(date, CARD, "Transit", "CityRide pass", 3200);
    if (carBought && weekday === 2 && chance(0.25)) spend(date, CARD, "Transit", "CityRide", between(275, 550));
    if (m === 15 && dom === 6) spend(date, SAVINGS, "Car", "AutoWorld -- used car", 1650000);
    if (carBought && (weekday === 4) && chance(0.55)) spend(date, CARD, "Fuel", pick(["QuickFuel", "Shoreline Gas"]), between(3800, 6400));
    if (carBought && dom === 14 && (m - 15) % 6 === 0) spend(date, CHECKING, "Car Insurance", "SafeRoad Insurance -- 6 months", between(68000, 76000));
    if (carBought && dom === 22 && (m === 19 || m === 26 || m === 33)) spend(date, CARD, "Car Service", "Precision Auto", between(18000, 64000));

    // ── Shopping and gifts ──────────────────────────────────────────────────
    if (chance(holiday ? 0.12 : 0.06)) {
      spend(date, CARD, "Shopping", pick(["Nordic Home Store", "BookNook", "Outfitters", "TechHub", "Garden Supply Co"]), between(1500, 18000));
    }
    if (month === 10 && dom === 28) spend(date, CARD, "Shopping", "TechHub -- Black Friday", between(25000, 60000));
    if (month === 11 && dom >= 5 && dom <= 20 && chance(0.35)) {
      spend(date, CARD, "Gifts", pick(["Toy Chest", "BookNook", "Artisan Market", "Outfitters"]), between(3000, 15000));
    }
    if (dom === 14 && month === 1) spend(date, CARD, "Gifts", "Petal & Stem", between(6000, 9000));

    // ── Health ──────────────────────────────────────────────────────────────
    if (chance(0.03)) spend(date, CARD, "Pharmacy", "GreenLeaf Pharmacy", between(900, 6500));
    if (dom === 16 && (month === 3 || month === 9)) spend(date, CHECKING, "Dentist", "Bright Smile Dental", between(9000, 26000));

    // ── Travel ──────────────────────────────────────────────────────────────
    if (month === 6) {
      const trip = summerTrips[yearIdx % summerTrips.length];
      if (dom === 2) spend(date, CARD, "Travel", `${trip.air} -- ${trip.city}`, between(90000, 160000));
      if (dom === 12) spend(date, trip.eur ? EURO : CARD, "Travel", trip.hotel, trip.eur ? between(60000, 90000) : between(80000, 130000));
      if (dom >= 10 && dom <= 16) spend(date, trip.eur ? EURO : CARD, "Dining Out", pick(trip.food), between(2500, 9000));
    }
    if (yearIdx === 1 && month === 11 && dom === 27) {
      spend(date, CARD, "Travel", "Summit Ski Lodge", 124000);
      spend(date, CARD, "Travel", "Peak Lift Tickets", 42000);
    }
    // A reimbursed work trip: in the ledger, out of the reports.
    if (m === 22 && dom === 11) {
      spend(date, CARD, "Work Expenses", "Conference hotel (reimbursed)", 68400, { excludeFromReports: true });
      earn(date, CHECKING, "Work Expenses", "TechCo expense reimbursement", 68400);
    }

    // ── Money movements ─────────────────────────────────────────────────────
    // Pay the card in full on the 20th.
    if (dom === 20 && bal.get(CARD)! < 0) move(date, CHECKING, CARD, "Card payment", -bal.get(CARD)!);
    // Sweep surplus checking into savings on the 2nd, keeping a cushion.
    if (dom === 2 && bal.get(CHECKING)! > 700000) {
      move(date, CHECKING, SAVINGS, "Monthly savings", Math.floor((bal.get(CHECKING)! - 500000) / 10000) * 10000);
    }
  }

  return rows;
}

export const EXTENDED_DATASET: SampleDataset = {
  accounts: ACCOUNTS,
  categories: CATEGORIES,
  transactions: generate,
};
