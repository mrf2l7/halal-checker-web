// Vercel Serverless Function: /api/check?ticker=AAPL
// يجلب البيانات من SEC مباشرة ويحسب الحكم.
const UA = "HalalCheckerWeb/1.0 (mrfaleh91@gmail.com)"; // حط بريدك لو تبغى
const ALLOW = new Set(["www.sec.gov", "data.sec.gov"]);

const LIMITS = { MAX_DTA: 0.30, MAX_CTA: 0.30, MAX_IMPURE: 0.05 };
const BANNED = [
  "alcohol","brewery","wine","spirits","gambling","casino","lottery",
  "pork","swine","pig","tobacco","cannabis","adult","porn",
  "bank","banking","mortgage","insurance","reinsurance","weapons","firearms","defense"
];

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function fetchSEC(url, type="json", retries=4){
  const host = new URL(url).hostname;
  if(!ALLOW.has(host)) throw new Error("Host not allowed: "+host);

  let lastErr;
  for(let i=0;i<retries;i++){
    try{
      await sleep(300 + i*600); // pacing + backoff
      const res = await fetch(url, {
        headers: {"User-Agent": UA, "Accept":"application/json, text/plain", "Referer":"https://www.sec.gov/"},
        redirect: "follow",
        cache: "no-store"
      });
      if (res.status===429 || res.status===403) throw new Error("HTTP "+res.status);
      if (!res.ok) throw new Error("HTTP "+res.status);
      return type==="text" ? await res.text() : await res.json();
    }catch(e){ lastErr=e; }
  }
  throw lastErr || new Error("Fetch failed");
}

function pad10(cik){ let s=String(Math.trunc(Number(cik)||0)); while(s.length<10) s="0"+s; return s; }
function safeDiv(a,b){ return (isFinite(a)&&isFinite(b)&&b!==0)?(a/b):0; }
function firstNZ(arr){ for(const x of arr){ if(isFinite(x)&&x>0) return x; } return 0; }
function sum(arr){ return arr.reduce((s,x)=>s+(isFinite(x)?x:0),0); }
function sumPos(arr){ return arr.reduce((s,x)=>s+(isFinite(x)&&x>0?x:0),0); }
function pick(gaap, keys){
  for (const k of keys) {
    const node = gaap[k]; if(!node||!node.units) continue;
    const usd = node.units.USD || node.units.usd; if(!usd) continue;
    const tenK = usd.filter(e=>(e.form||"").toUpperCase()==="10-K");
    const tenQ = usd.filter(e=>(e.form||"").toUpperCase()==="10-Q");
    const pool = (tenK.length?tenK:tenQ).slice().sort((a,b)=>new Date(b.end||0)-new Date(a.end||0));
    const p = pool[0];
    if(p && isFinite(Number(p.val))) return Number(p.val);
  }
  return 0;
}

async function mapTickerToCik(ticker){
  try{
    const txt = await fetchSEC("https://www.sec.gov/include/ticker.txt","text");
    const hit = txt.split(/\r?\n/).find(line => {
      const p=line.trim().split(/[|\s]+/);
      return p[0] && p[0].toUpperCase()===ticker.toUpperCase();
    });
    if(hit){
      const parts = hit.trim().split(/[|\s]+/);
      const cikStr = parts[1].replace(/^0+/,"");
      return Number(cikStr);
    }
  }catch(_){}
  try{
    const j1 = await fetchSEC("https://www.sec.gov/files/company_tickers.json");
    const a1 = Array.isArray(j1)?j1:Object.values(j1||{});
    const h1 = a1.find(o => (o.ticker||"").toUpperCase()===ticker.toUpperCase());
    if(h1) return Number(h1.cik_str || h1.cik);
  }catch(_){}
  const j2 = await fetchSEC("https://www.sec.gov/files/company_tickers_exchange.json");
  const a2 = Array.isArray(j2)?j2:Object.values(j2||{});
  const h2 = a2.find(o => (o.ticker||"").toUpperCase()===ticker.toUpperCase());
  if(h2) return Number(h2.cik_str || h2.cik);
  throw new Error("Ticker not found via SEC maps");
}

export default async function handler(req, res){
  try{
    const ticker = String((req.query?.ticker || "")).trim().toUpperCase();
    if(!ticker) return res.status(400).json({ error: "Missing ticker" });

    const cik = await mapTickerToCik(ticker);

    const submissions = await fetchSEC(`https://data.sec.gov/submissions/CIK${pad10(cik)}.json`);
    const sicDesc = (submissions.sicDescription || "").toLowerCase();
    const banned = BANNED.find(k => sicDesc.includes(k));
    if (banned){
      res.setHeader("Cache-Control","public, max-age=900");
      return res.status(200).json({ ticker, cik, status:"Haram", note:`Excluded by SIC: ${submissions.sic} ${submissions.sicDescription||""}` });
    }

    const facts = await fetchSEC(`https://data.sec.gov/api/xbrl/companyfacts/CIK${pad10(cik)}.json`);
    const F = (facts.facts && facts.facts["us-gaap"]) ? facts.facts["us-gaap"] : {};

    const assets  = pick(F,["Assets"]);
    const debt    = firstNZ([ pick(F,["Debt"]), pick(F,["InterestBearingLiabilities"]), pick(F,["Liabilities"]) ]);
    const cash    = sum([ pick(F,["CashAndCashEquivalentsAtCarryingValue"]), pick(F,["ShortTermInvestments"]) ]);
    const revenue = firstNZ([ pick(F,["Revenues"]), pick(F,["SalesRevenueNet"]), pick(F,["RevenueFromContractWithCustomerExcludingAssessedTax"]) ]);
    const interestIncome = sumPos([
      pick(F,["InterestIncome"]),
      pick(F,["InterestAndDividendIncomeOperating"]),
      pick(F,["InterestAndDividendIncome"]),
      pick(F,["InterestIncomeNonoperating"]),
      pick(F,["InvestmentIncomeInterest"])
    ]);

    if(!assets || !revenue) throw new Error("Insufficient SEC data (Assets or Revenue).");

    const dta = safeDiv(debt,assets);
    const cta = safeDiv(cash,assets);
    const irr = Math.min(1, (revenue ? (interestIncome/revenue) : 0));

    const debtOk = isFinite(dta) && dta <= LIMITS.MAX_DTA;
    const cashOk = isFinite(cta) && cta <= LIMITS.MAX_CTA;

    let status="Halal", note="";
    if(!debtOk || !cashOk){
      status="Haram";
      const reasons=[];
      if(!debtOk) reasons.push(`Debt/Assets > ${(LIMITS.MAX_DTA*100).toFixed(0)}%`);
      if(!cashOk) reasons.push(`Cash/Assets > ${(LIMITS.MAX_CTA*100).toFixed(0)}%`);
      if(irr > LIMITS.MAX_IMPURE) reasons.push(`Impure Rev ${(irr*100).toFixed(2)}% > ${(LIMITS.MAX_IMPURE*100).toFixed(0)}%`);
      note = reasons.join(" | ");
    }else{
      if(irr===0) status="Halal";
      else if(irr>0 && irr<=LIMITS.MAX_IMPURE){
        status="Needs Purification";
        note = `Purification = ${(irr*100).toFixed(2)}% of gains.`;
      }else{
        status="Haram";
        note = `Impure revenue ${(irr*100).toFixed(2)}% > ${(LIMITS.MAX_IMPURE*100).toFixed(0)}%.`;
      }
    }

    res.setHeader("Cache-Control","public, max-age=900");
    return res.status(200).json({ ticker, cik, status, debtToAssets:dta, cashToAssets:cta, impureRevenue:irr, note });
  }catch(e){
    return res.status(500).json({ error: String(e.message||e) });
  }
}
