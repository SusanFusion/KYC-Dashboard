// Login roster — who's allowed in, and which role/agent they map to.
//
// Transcribed from the "KYC - AI App Creation Roster" CSV. A handful of
// names there are shortened (no middle name) or spelled slightly differently
// than the fuller legal names already used as the scoring roster
// (src/lib/data/seed/agents.ts) — agentId below is the verified match to
// that seed roster, checked by hand once here so login never needs fuzzy
// name-matching at request time:
//   "Hans Diaz"      -> hans-nicole-diaz    (seed: "Hans Nicole Diaz")
//   "Katrina Carangui" -> katrina-carungui  (seed: "Katrina Carungui" — the
//                          roster CSV's own email column already spells it
//                          "carungui", matching the seed; only the display
//                          name column has the "Carangui" typo)
//   "Maria Lopez"    -> maria-patrisha-lopez (seed: "Maria Patrisha Lopez")
//   "Patricia Cruz"  -> patricia-marie-cruz  (seed: "Patricia Marie Cruz")
// Every other KYC Officer name matched the seed roster exactly.
//
// Leads/Auditors aren't scored agents, so their agentId is always null.
export type UserRole = "agent" | "lead";

export interface RosterEntry {
  /** Always lowercase — comparisons normalize the submitted email to match. */
  email: string;
  name: string;
  role: UserRole;
  agentId: string | null;
}

export const ROSTER: RosterEntry[] = [
  // KYC Officers (agents)
  { email: "abigael.callos@fusionmarkets.com", name: "Abigael Callos", role: "agent", agentId: "abigael-callos" },
  { email: "aimee.hicana@fusionmarkets.com", name: "Aimee Hicana", role: "agent", agentId: "aimee-hicana" },
  { email: "alain.sebastian@fusionmarkets.com", name: "Alain Sebastian", role: "agent", agentId: "alain-sebastian" },
  { email: "rose.amamio@fusionmarkets.com.au", name: "Angeline Amamio", role: "agent", agentId: "angeline-amamio" },
  { email: "earl.insierto@fusionmarkets.com", name: "Earl Insierto", role: "agent", agentId: "earl-insierto" },
  { email: "evangeline.deocampo@fusionmarkets.com.au", name: "Evangeline De Ocampo", role: "agent", agentId: "evangeline-de-ocampo" },
  { email: "hanz.diaz@fusionmarkets.com", name: "Hans Diaz", role: "agent", agentId: "hans-nicole-diaz" },
  { email: "jayann.oteros@fusionmarkets.com", name: "Jay-Ann Oteros", role: "agent", agentId: "jay-ann-oteros" },
  { email: "jenieme.antong@fusionmarkets.com", name: "Jenieme Antong", role: "agent", agentId: "jenieme-antong" },
  { email: "jessamae.candongo@fusionmarkets.com", name: "Jessamae Candongo", role: "agent", agentId: "jessamae-candongo" },
  { email: "katrina.carungui@fusionmarkets.com", name: "Katrina Carangui", role: "agent", agentId: "katrina-carungui" },
  { email: "lailani.palle@fusionmarkets.com", name: "Lailani Palle", role: "agent", agentId: "lailani-palle" },
  { email: "mapatrisha.lopez@fusionmarkets.com", name: "Maria Lopez", role: "agent", agentId: "maria-patrisha-lopez" },
  { email: "michelle.barcelona@fusionmarkets.com", name: "Michelle Barcelona", role: "agent", agentId: "michelle-barcelona" },
  { email: "patricia.cruz@fusionmarkets.com", name: "Patricia Cruz", role: "agent", agentId: "patricia-marie-cruz" },
  { email: "yuri.bulahan@fusionmarkets.com", name: "Yuri Bulahan", role: "agent", agentId: "yuri-bulahan" },
  { email: "yvonne.tang@fusionmarkets.com", name: "Yvonne Tang", role: "agent", agentId: "yvonne-tang" },
  { email: "lizbeth.belmont@fusionmarkets.com", name: "Lizbeth Belmont", role: "agent", agentId: "lizbeth-belmont" },
  { email: "fernan.hernandez@fusionmarkets.com", name: "Fernan Hernandez", role: "agent", agentId: "fernan-hernandez" },
  { email: "jovie.generillo@fusionmarkets.com", name: "Jovie Generillo", role: "agent", agentId: "jovie-generillo" },
  { email: "reina.lojo@fusionmarkets.com", name: "Reina Lojo", role: "agent", agentId: "reina-lojo" },

  // KYC Leads / Auditors (leads)
  { email: "susan.gonzalez@fusionmarkets.com", name: "Susan Gonzalez", role: "lead", agentId: null },
  { email: "marie.alvarez@fusionmarkets.com", name: "Marie Antonette Alvarez", role: "lead", agentId: null },
  { email: "merry.datul@fusionmarkets.com.au", name: "Merry Elizabeth Datul", role: "lead", agentId: null },
];

export function findRosterEntry(rawEmail: string): RosterEntry | null {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return null;
  return ROSTER.find((r) => r.email === email) ?? null;
}
