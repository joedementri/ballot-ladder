// Raw data sources. All are free/public; see pipeline/README.md for licenses.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RAW = join(import.meta.dirname, 'raw');
const CB = 'https://www2.census.gov/geo/tiger/GENZ2024/shp';
const GH = "https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master";
const DV = 'https://dataverse.harvard.edu/api/access/datafile';

export const SOURCES: Record<string, string> = {
  'state.zip': `${CB}/cb_2024_us_state_5m.zip`,
  'county.zip': `${CB}/cb_2024_us_county_5m.zip`,
  'cd.zip': `${CB}/cb_2024_us_cd119_5m.zip`,
  'sldu.zip': `${CB}/cb_2024_us_sldu_500k.zip`,
  'sldl.zip': `${CB}/cb_2024_us_sldl_500k.zip`,
  'gaz_place.zip': 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip',
  'gaz_cousub.zip': 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_cousubs_national.zip',
  'gaz_tract.zip': 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_tracts_national.zip',
  'subest.csv': 'https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv',
  // County presidential: MEDSL county file is behind a guestbook, so use tonmcg (MIT license).
  "cty_08_16.csv": `${GH}/US_County_Level_Presidential_Results_08-16.csv`,
  "cty_2016.csv": `${GH}/2016_US_County_Level_Presidential_Results.csv`,
  "cty_2020.csv": `${GH}/2020_US_County_Level_Presidential_Results.csv`,
  "cty_2024.csv": `${GH}/2024_US_County_Level_Presidential_Results.csv`,
  'statepres.csv': `${DV}/13887042`,
  'senate.csv': `${DV}/13887039?format=original`,
  // Optional manual file (behind a Dataverse guestbook): MEDSL 1976-2024-house.tab saved as raw/house.tab
  "legislators.json": "https://unitedstates.github.io/congress-legislators/legislators-current.json",
};

export const STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
for (const st of STATES) if (st !== "DC") SOURCES[`os_${st}.csv`] = `https://data.openstates.org/people/current/${st.toLowerCase()}.csv`;

// ACS 5-year 2023 table-based summary files (no API key needed). Pipe-delimited, all geographies.
const ACS = "https://www2.census.gov/programs-surveys/acs/summary_file/2023/table-based-SF/data/5YRData";
export const ACS_TABLES = ["b01003", "b01002", "b19013", "b03002", "b15003"];
for (const t of ACS_TABLES) SOURCES[`acs_${t}.dat`] = `${ACS}/acsdt5y2023-${t}.dat`;

export async function download(force = false) {
  mkdirSync(RAW, { recursive: true });
  for (const [name, url] of Object.entries(SOURCES)) {
    const dest = join(RAW, name);
    if (existsSync(dest) && !force) continue;
    process.stdout.write(`downloading ${name} ... `);
    const res = await fetch(url, { headers: { 'User-Agent': 'us-political-sim-pipeline' } });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log('ok');
  }
}

if (process.argv[1]?.endsWith('sources.ts')) download().catch((e) => { console.error(e); process.exit(1); });
