// Adapted local TI-36X Pro source. See PROVENANCE.md. No global TI namespace.
import styles from './style.css?inline';
import markup from './markup.html?raw';
const calculatorScope = { TI: {}, document: globalThis.document, get navigator() { return globalThis.navigator; },
  URL: globalThis.URL, ClipboardItem: globalThis.ClipboardItem, setTimeout: globalThis.setTimeout,
  get localStorage() { return globalThis.localStorage; } };
// Upstream source: engine.js
/* Math engine: symbols, number types, parser, evaluator and result formatting.
   Pure logic with no DOM access, so it can be tested in Node. */
(function (G) {
'use strict';
const TI = G.TI || (G.TI = {});

// ---------------------------------------------------------------- errors
class CalcError extends Error {
  constructor(type, hint) { super(type); this.type = type; this.hint = hint || ''; }
}
function err(type, hint) { throw new CalcError(type, hint); }

// ---------------------------------------------------------------- symbols
// Every item in an entry row is either {s:id} (a symbol) or {t:type, a:[slots]} (a MathPrint template).
const SYM = {};
function def(id, d, k, extra) { SYM[id] = Object.assign({ id, d, k }, extra || {}); }

'0123456789'.split('').forEach(c => def(c, c, 'dig'));
def('.', '.', 'dig');
'ABCDEF'.split('').forEach(c => def('h' + c, c, 'dig', { hex: true }));
def('E', 'E', 'ee');

def('+', '+', 'bin', { p: 40 });
def('-', '−', 'bin', { p: 40 });
def('*', '×', 'bin', { p: 50 });
def('/', '÷', 'bin', { p: 50 });
def('^', '^', 'bin', { p: 80, left: true });         // Classic-mode power (left to right)
def('xroot', 'ˣ√', 'bin', { p: 80 });               // Classic-mode nth root: n ˣ√ x
def('cfrac', '⁄', 'bin', { p: 95 });                // Classic-mode fraction bar
def('cmix', '⌟', 'bin', { p: 94 });                 // Classic-mode mixed-number separator
def('nCr', ' nCr ', 'bin', { p: 60 });
def('nPr', ' nPr ', 'bin', { p: 60 });
def('and', ' and ', 'bin', { p: 35 });
def('nand', ' nand ', 'bin', { p: 35 });
def('or', ' or ', 'bin', { p: 30 });
def('xor', ' xor ', 'bin', { p: 30 });
def('xnor', ' xnor ', 'bin', { p: 30 });
def('angle', '∠', 'bin', { p: 45 });
def('neg', '-', 'neg');
def('(', '(', 'lp');
def(')', ')', 'rp');
def(',', ',', 'comma');
def('sto', '→', 'sto');

def('sq', '²', 'post');
def('inv', '⁻¹', 'post');
def('!', '!', 'post');
def('%', '%', 'post');
def('deg', '°', 'post', { dms: 1 });
def('min', '′', 'post', { dms: 1 });
def('sec', '″', 'post', { dms: 1 });
def('rad', 'ʳ', 'post');
def('grad', 'ᵍ', 'post');
def('T', 'ᵀ', 'post');
def('op', ' op', 'post');

'xyztabcd'.split('').forEach(v => def(v, v, 'val', { isVar: true, h: '<i>' + v + '</i>' }));
def('pi', 'π', 'val');
def('e', 'e', 'val', { h: '<i class="ke">e</i>' });
def('i', 'i', 'val', { h: '<i class="ki">i</i>' });
def('ans', 'ans', 'val');
def('rand', 'rand', 'val');

// Physical constant values used by the TI-36X Pro, transcribed from the
// guidebook calculation table (printed p. 65):
// https://education.ti.com/html/eguides/scientifics/PDFs/EN/TI-36X-PRO-Guidebook_EN.pdf
const CONSTANTS = [
  ['c', 'c', 'speed of light', 'm/s', 299792458],
  ['g', 'g', 'gravitational acc', 'm/s²', 9.80665],
  ['h', 'h', 'Planck constant', 'J·s', 6.62606896e-34],
  ['NA', 'N<sub>A</sub>', "Avogadro's no.", '/mol', 6.02214179e23],
  ['R', 'R', 'ideal gas const', 'J/(mol·K)', 8.314472],
  ['me', 'm<sub>e</sub>', 'electron mass', 'kg', 9.109381215e-31],
  ['mp', 'm<sub>p</sub>', 'proton mass', 'kg', 1.672621637e-27],
  ['mn', 'm<sub>n</sub>', 'neutron mass', 'kg', 1.674927211e-27],
  ['mmu', 'm<sub>μ</sub>', 'muon mass', 'kg', 1.88353130e-28],
  ['G', 'G', 'univ gravitation', 'm³/(kg·s²)', 6.67428e-11],
  ['F', 'F', 'Faraday constant', 'C/mol', 96485.3399],
  ['a0', 'a<sub>0</sub>', 'Bohr radius', 'm', 5.2917720859e-11],
  ['re', 'r<sub>e</sub>', 'class. e⁻ radius', 'm', 2.8179402894e-15],
  ['k', 'k', 'Boltzmann const', 'J/K', 1.3806504e-23],
  ['e', 'e', 'electron charge', 'C', 1.602176487e-19],
  ['u', 'u', 'atomic mass unit', 'kg', 1.660538782e-27],
  ['atm', 'atm', 'standard atm', 'Pa', 101325],
  ['eps0', 'ε<sub>0</sub>', 'permittivity vac', 'F/m', 8.854187817620e-12],
  ['mu0', 'μ<sub>0</sub>', 'permeability vac', 'N/A²', 1.256637061436e-6],
  ['Cc', 'C<sub>c</sub>', "Coulomb's const", 'm/F', 8.987551787368e9],
];
CONSTANTS.forEach(([id, h, name, unit, v]) =>
  def('K_' + id, h.replace(/<\/?sub>/g, ''), 'val', { h: '<b class="kc">' + h + '</b>', konst: v, name, unit }));

// Unit conversions (postfix, high priority: enclose negatives in parentheses).
const CONVERSIONS = [
  ['English-Metric', [
    ['in_cm', 'in►cm', x => x * 2.54], ['cm_in', 'cm►in', x => x / 2.54],
    ['ft_m', 'ft►m', x => x * 0.3048], ['m_ft', 'm►ft', x => x / 0.3048],
    ['yd_m', 'yd►m', x => x * 0.9144], ['m_yd', 'm►yd', x => x / 0.9144],
    ['mi_km', 'mile►km', x => x * 1.609344], ['km_mi', 'km►mile', x => x / 1.609344],
    ['ac_m2', 'acre►m²', x => x * 4046.8564224], ['m2_ac', 'm²►acre', x => x / 4046.8564224],
    ['galus_L', 'gal US►L', x => x * 3.785411784], ['L_galus', 'L►gal US', x => x / 3.785411784],
    ['galuk_L', 'gal UK►ltr', x => x * 4.54609], ['L_galuk', 'ltr►gal UK', x => x / 4.54609],
    ['oz_g', 'oz►gm', x => x * 28.349523125], ['g_oz', 'gm►oz', x => x / 28.349523125],
    ['lb_kg', 'lb►kg', x => x * 0.45359237], ['kg_lb', 'kg►lb', x => x / 0.45359237],
  ]],
  ['Temperature', [
    ['F_C', '°F►°C', x => (x - 32) * 5 / 9], ['C_F', '°C►°F', x => x * 9 / 5 + 32],
    ['C_K', '°C►°K', x => x + 273.15], ['K_C', '°K►°C', x => x - 273.15],
  ]],
  ['Speed and Length', [
    ['kmh_ms', 'km/hr►m/s', x => x / 3.6], ['ms_kmh', 'm/s►km/hr', x => x * 3.6],
    ['ly_m', 'LtYr►m', x => x * 9.4607304725808e15], ['m_ly', 'm►LtYr', x => x / 9.4607304725808e15],
    ['pc_m', 'pc►m', x => x * 3.0856775814914e16], ['m_pc', 'm►pc', x => x / 3.0856775814914e16],
    ['A_m', 'Ang►m', x => x * 1e-10], ['m_A', 'm►Ang', x => x * 1e10],
  ]],
  ['Pressure', [
    ['atm_Pa', 'atm►Pa', x => x * 101325], ['Pa_atm', 'Pa►atm', x => x / 101325],
    ['mmHg_Pa', 'mmHg►Pa', x => x * 133.322387415], ['Pa_mmHg', 'Pa►mmHg', x => x / 133.322387415],
  ]],
  ['Power and Energy', [
    ['J_kWh', 'J►kWh', x => x / 3.6e6], ['kWh_J', 'kWh►J', x => x * 3.6e6],
    ['J_cal', 'J►cal', x => x / 4.184], ['cal_J', 'cal►J', x => x * 4.184],
    ['hp_kW', 'hp►kW', x => x * 0.745699872], ['kW_hp', 'kW►hp', x => x / 0.745699872],
  ]],
];
CONVERSIONS.forEach(([, list]) => list.forEach(([id, label, f]) => def('U_' + id, label, 'post', { unit: f })));

// Display conversions (lowest-priority postfix, valid at the end of an entry).
def('toFrac', '►n/d◄►Un/d', 'conv');
def('toFD', '►F◄►D', 'conv');
def('toDMS', '►DMS', 'conv');
def('toHex', '►Hex', 'conv');
def('toBin', '►Bin', 'conv');
def('toDec', '►Dec', 'conv');
def('toOct', '►Oct', 'conv');
def('toPolar', '►r∠θ', 'conv');
def('toRect', '►a+bi', 'conv');
def('toPf', '►Pfactor', 'conv');

def('sh', 'ʰ', 'suf', { base: 16 });
def('sb', 'ᵇ', 'suf', { base: 2 });
def('sd', 'ᵈ', 'suf', { base: 10 });
def('so', 'ᵒ', 'suf', { base: 8 });

// Functions that take arguments in parentheses.
const FUNCS = {
  'sin(': 'sin(', 'cos(': 'cos(', 'tan(': 'tan(',
  'asin(': 'sin⁻¹(', 'acos(': 'cos⁻¹(', 'atan(': 'tan⁻¹(',
  'sinh(': 'sinh(', 'cosh(': 'cosh(', 'tanh(': 'tanh(',
  'asinh(': 'sinh⁻¹(', 'acosh(': 'cosh⁻¹(', 'atanh(': 'tanh⁻¹(',
  'ln(': 'ln(', 'log(': 'log(',
  'csqrt(': '√(', 'cexp(': 'e^(', 'c10(': '10^(',
  'abs(': 'abs(', 'round(': 'round(', 'iPart(': 'iPart(', 'fPart(': 'fPart(', 'int(': 'int(',
  'min(': 'min(', 'max(': 'max(', 'mod(': 'mod(', 'lcm(': 'lcm(', 'gcd(': 'gcd(',
  'PRx(': 'P►Rx(', 'PRy(': 'P►Ry(', 'RPr(': 'R►Pr(', 'RPt(': 'R►Pθ(',
  'randint(': 'randint(', 'nDeriv(': 'nDeriv(', 'fnInt(': 'fnInt(', 'sum(': 'sum(', 'prod(': 'prod(',
  'det(': 'det(', 'ref(': 'ref(', 'rref(': 'rref(',
  'DotP(': 'DotP(', 'CrossP(': 'CrossP(', 'norm(': 'norm(',
  'angle(': 'angle(', 'conj(': 'conj(', 'real(': 'real(', 'imag(': 'imag(',
  'not(': 'not(', 'twos(': "2's(", 'f(': 'f(',
  'S_xp(': 'x′(', 'S_yp(': 'y′(',
};
Object.keys(FUNCS).forEach(id => def(id, FUNCS[id], 'fn'));

// Statistics result variables.
const STATVARS = {
  S_n: 'n', S_xbar: 'x̄', S_Sx: 'Sx', S_sx: 'σx', S_Sumx: 'Σx', S_Sumx2: 'Σx²',
  S_ybar: 'ȳ', S_Sy: 'Sy', S_sy: 'σy', S_Sumy: 'Σy', S_Sumy2: 'Σy²', S_Sumxy: 'Σxy',
  S_a: 'a', S_b: 'b', S_c: 'c', S_d: 'd', S_r2: 'r²', S_r: 'r', S_R2: 'R²',
  S_minX: 'MinX', S_Q1: 'Q1', S_Med: 'Med', S_Q3: 'Q3', S_maxX: 'MaxX', S_minY: 'MinY', S_maxY: 'MaxY',
};
Object.keys(STATVARS).forEach(id => def(id, STATVARS[id], 'val', { stat: true, h: '<b class="ks">' + STATVARS[id] + '</b>' }));

['L1', 'L2', 'L3'].forEach(id => def(id, id, 'val', { list: true, h: 'L<sub>' + id[1] + '</sub>' }));
[['mA', '[A]'], ['mB', '[B]'], ['mC', '[C]'], ['mAns', '[Ans]'], ['mI2', '[I2]'], ['mI3', '[I3]']]
  .forEach(([id, d]) => def(id, d, 'val', { mat: true }));
[['vU', '[u]'], ['vV', '[v]'], ['vW', '[w]'], ['vAns', '[Ans]']]
  .forEach(([id, d]) => def(id, d, 'val', { vec: true }));

// MathPrint templates: number of slots and the order the cursor visits them.
const TPL = {
  frac: { n: 2 }, mixed: { n: 3 }, pow: { n: 1 }, sqrt: { n: 1 }, root: { n: 2 },
  exp_e: { n: 1 }, exp_10: { n: 1 }, abs: { n: 1 },
  deriv: { n: 3 }, integ: { n: 4 }, sum: { n: 3 }, prod: { n: 3 },
  mat: { n: -1 }, list: { n: -1 },
};

// ---------------------------------------------------------------- numbers
class Cx { constructor(re, im) { this.re = re; this.im = im || 0; } }
const cx = (re, im) => new Cx(re, im || 0);
class Mat { constructor(rows) { this.rows = rows; } get r() { return this.rows.length; } get c() { return this.rows[0].length; } }
class Vec { constructor(a) { this.a = a; } }
class List { constructor(a) { this.a = a; } }

const isCx = v => v instanceof Cx;
const PI = Math.PI;

function round14(x) {
  if (!isFinite(x) || x === 0) return x;
  return parseFloat(x.toPrecision(14));
}
function checkNum(x) {
  if (Number.isNaN(x)) err('DOMAIN');
  if (!isFinite(x) || Math.abs(x) >= 1e100) err('OVERFLOW');
  if (Math.abs(x) < 1e-99) return 0;
  return x;
}
function clean(z) {
  let re = round14(checkNum(z.re)), im = round14(checkNum(z.im));
  if (im !== 0 && Math.abs(im) < 1e-13 * Math.abs(re)) im = 0;
  if (re !== 0 && Math.abs(re) < 1e-13 * Math.abs(im)) re = 0;
  return cx(re === 0 ? 0 : re, im === 0 ? 0 : im);
}
function addR(a, b) {
  const s = a + b;
  if (s !== 0 && Math.abs(s) < 1e-14 * Math.max(Math.abs(a), Math.abs(b))) return 0;
  return s;
}
const cAdd = (a, b) => cx(addR(a.re, b.re), addR(a.im, b.im));
const cSub = (a, b) => cx(addR(a.re, -b.re), addR(a.im, -b.im));
function cMul(a, b) {
  if (a.im === 0 && b.im === 0) return cx(a.re * b.re);
  return cx(addR(a.re * b.re, -a.im * b.im), addR(a.re * b.im, a.im * b.re));
}
function cDiv(a, b) {
  if (b.re === 0 && b.im === 0) err('DIVIDE BY 0');
  if (a.im === 0 && b.im === 0) return cx(a.re / b.re);
  const d = b.re * b.re + b.im * b.im;
  return cx(addR(a.re * b.re, a.im * b.im) / d, addR(a.im * b.re, -a.re * b.im) / d);
}
const cAbs = a => (a.im === 0 ? Math.abs(a.re) : Math.hypot(a.re, a.im));
const cArg = a => Math.atan2(a.im, a.re);
function cExp(a) { const m = Math.exp(a.re); return a.im === 0 ? cx(m) : cx(m * Math.cos(a.im), m * Math.sin(a.im)); }
function cLn(a) { return cx(Math.log(cAbs(a)), cArg(a)); }
function cSqrt(a) {
  if (a.im === 0 && a.re >= 0) return cx(Math.sqrt(a.re));
  if (a.im === 0) return cx(0, Math.sqrt(-a.re));
  const m = cAbs(a), re = Math.sqrt((m + a.re) / 2), im = Math.sign(a.im) * Math.sqrt((m - a.re) / 2);
  return cx(re, im);
}
const isInt = x => Number.isInteger(x) || (Math.abs(x) < 1e15 && Math.abs(x - Math.round(x)) < 1e-10 * Math.max(1, Math.abs(x)));

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }

// Best rational approximation p/q (q <= maxDen) within tolerance, else null.
function rat(x, maxDen, tol) {
  if (!isFinite(x)) return null;
  const neg = x < 0; x = Math.abs(x);
  if (x > 1e12) return null;
  tol = tol == null ? 1e-13 * Math.max(1, x) : tol;
  // Larger numbers keep fewer spare digits, so only small denominators are trustworthy.
  maxDen = Math.min(maxDen, Math.floor(Math.sqrt(1.6e-4 / (tol * 3))));
  let h0 = 0, h1 = 1, k0 = 1, k1 = 0, y = x;
  for (let it = 0; it < 40; it++) {
    const a = Math.floor(y);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    if (Math.abs(x - h1 / k1) <= tol) return [neg ? -h1 : h1, k1];
    const f = y - a;
    if (f < 1e-18) break;
    y = 1 / f;
  }
  return null;
}
// Split n into s*s*r with r square-free.
function sqfree(n) {
  let s = 1, r = n;
  for (let p = 2; p * p <= r; p++) {
    while (r % (p * p) === 0) { r /= p * p; s *= p; }
  }
  return [s, r];
}

// ---------------------------------------------------------------- settings
function defaultSettings() {
  return { angle: 'DEG', notation: 'NORM', fix: null, cplx: 'REAL', base: 'DEC', mathprint: true };
}
const BASE_BITS = { HEX: 40, OCT: 30, BIN: 10, DEC: 40 };
const BASE_RADIX = { HEX: 16, OCT: 8, BIN: 2, DEC: 10 };

// ---------------------------------------------------------------- lexer
function lex(items, ctx) {
  const toks = [];
  let i = 0;
  const symAt = j => (j < items.length && !items[j].t ? SYM[items[j].s] : null);
  while (i < items.length) {
    const it = items[i];
    if (it.t) { toks.push({ tt: 'tpl', node: it }); i++; continue; }
    const s = SYM[it.s];
    if (!s) err('SYNTAX');
    if (s.k === 'dig' || s.k === 'ee') {
      let txt = '', j = i;
      while (symAt(j) && symAt(j).k === 'dig') { txt += symAt(j).d; j++; }
      let ex = null;
      if (symAt(j) && symAt(j).id === 'E') {
        j++;
        let sign = '';
        if (symAt(j) && (symAt(j).id === 'neg' || symAt(j).id === '-')) { sign = '-'; j++; }
        let ed = '';
        while (symAt(j) && /^[0-9]$/.test(symAt(j).id)) { ed += symAt(j).id; j++; }
        if (!ed) err('SYNTAX');
        ex = sign + ed;
      }
      let base = null;
      if (symAt(j) && symAt(j).k === 'suf') { base = symAt(j).base; j++; }
      toks.push(makeNum(txt, ex, base, ctx));
      i = j;
      continue;
    }
    if (s.k === 'suf') err('SYNTAX');
    toks.push({ tt: s.k, s, id: s.id });
    i++;
  }
  return toks;
}

function makeNum(txt, ex, base, ctx) {
  const mode = ctx.st.base;
  const radix = base || BASE_RADIX[mode];
  if (txt === '' ) err('SYNTAX');
  if (radix !== 10) {
    if (ex != null || txt.includes('.')) err('SYNTAX');
    const valid = { 2: /^[01]+$/, 8: /^[0-7]+$/, 16: /^[0-9A-F]+$/ }[radix];
    if (!valid.test(txt)) err('SYNTAX');
    const bits = BASE_BITS[base ? ({ 16: 'HEX', 8: 'OCT', 2: 'BIN' })[radix] : mode];
    let v = parseInt(txt, radix);
    if (v >= Math.pow(2, bits)) err('OVERFLOW');
    if (v >= Math.pow(2, bits - 1)) v -= Math.pow(2, bits);
    return { tt: 'num', v: cx(v), approx: false };
  }
  if (/[A-F]/.test(txt)) err('SYNTAX');
  if ((txt.match(/\./g) || []).length > 1 || txt === '.') err('SYNTAX');
  const v = Number(txt + (ex != null ? 'e' + ex : ''));
  if (!isFinite(v) || Math.abs(v) >= 1e100) err('OVERFLOW');
  return { tt: 'num', v: cx(v), approx: txt.includes('.') || ex != null };
}

// ---------------------------------------------------------------- parser
function startsOperand(t) {
  if (!t) return false;
  if (t.tt === 'tpl') return t.node.t !== 'pow';
  return t.tt === 'num' || t.tt === 'val' || t.tt === 'fn' || t.tt === 'lp' || t.tt === 'neg';
}
function lbp(t) {
  if (!t) return 0;
  switch (t.tt) {
    case 'bin': return t.s.p;
    case 'post': return 90;
    case 'conv': return 20;
    case 'sto': return 5;
    case 'tpl': return t.node.t === 'pow' ? 80 : 50;
    case 'num': case 'val': case 'fn': case 'lp': case 'neg': return 50;
    default: return 0;
  }
}

class Parser {
  constructor(toks, ctx) { this.t = toks; this.p = 0; this.ctx = ctx; }
  peek() { return this.t[this.p]; }
  next() { return this.t[this.p++]; }
  parse(rbp) {
    const tok = this.next();
    if (!tok) err('SYNTAX');
    let left = this.nud(tok);
    for (;;) {
      const nt = this.peek();
      if (!nt || lbp(nt) <= rbp) break;
      left = this.led(left, nt);
    }
    return left;
  }
  nud(t) {
    switch (t.tt) {
      case 'num': return { k: 'num', v: t.v, approx: t.approx };
      case 'val': return { k: 'val', id: t.id };
      case 'neg': {
        const a = this.parse(70);
        return { k: 'neg', a, dms: !!a.dms };
      }
      case 'lp': {
        const e = this.parse(0);
        const n = this.peek();
        if (n && n.tt === 'rp') this.next(); else if (n) err('SYNTAX');
        return { k: 'paren', a: e, dms: !!e.dms };
      }
      case 'fn': {
        const args = [];
        const n0 = this.peek();
        if (n0 && n0.tt === 'rp') { this.next(); return { k: 'call', id: t.id, args }; }
        for (;;) {
          args.push(this.parse(0));
          const n = this.peek();
          if (!n) break;
          if (n.tt === 'comma') { this.next(); continue; }
          if (n.tt === 'rp') { this.next(); break; }
          err('SYNTAX');
        }
        return { k: 'call', id: t.id, args };
      }
      case 'tpl': return this.tpl(t.node);
      default: err('SYNTAX');
    }
  }
  tpl(node) {
    const sub = items => parseItems(items, this.ctx);
    const a = node.a;
    switch (node.t) {
      case 'frac': return { k: 'frac', n: sub(a[0]), d: sub(a[1]) };
      case 'mixed': return { k: 'mixed', w: sub(a[0]), n: sub(a[1]), d: sub(a[2]) };
      case 'sqrt': return { k: 'sqrt', a: sub(a[0]) };
      case 'root': return { k: 'root', n: sub(a[0]), a: sub(a[1]) };
      case 'exp_e': return { k: 'exp_e', a: sub(a[0]) };
      case 'exp_10': return { k: 'exp_10', a: sub(a[0]) };
      case 'abs': return { k: 'call', id: 'abs(', args: [sub(a[0])] };
      case 'deriv': return { k: 'deriv', f: sub(a[0]), v: varOf(a[1]), at: sub(a[2]), h: null };
      case 'integ': return { k: 'integ', lo: sub(a[0]), hi: sub(a[1]), f: sub(a[2]), v: varOf(a[3]) };
      case 'sum': case 'prod': return { k: node.t, lo: sub(a[0]), hi: sub(a[1]), f: sub(a[2]), v: 'x' };
      case 'mat': return { k: 'matlit', r: node.r, c: node.c, cells: a.map(sub) };
      case 'list': return { k: 'listlit', cells: a.map(sub) };
      case 'pow': err('SYNTAX');
    }
    err('SYNTAX');
  }
  led(left, t) {
    if (startsOperand(t)) {
      // implied multiplication (DMS parts are added instead)
      const right = this.parse(50);
      if (left.dms && right.dms) return { k: 'bin', op: '+', a: left, b: right, dms: true };
      return { k: 'bin', op: '*', a: left, b: right, implied: true };
    }
    this.next();
    switch (t.tt) {
      case 'bin': {
        if (t.id === 'cfrac') return { k: 'frac', n: left, d: this.parse(95) };
        if (t.id === 'cmix') return { k: 'mixed', w: left, n: null, d: null, rest: this.parse(94) };
        if (t.id === 'xroot') return { k: 'root', n: left, a: this.parse(80) };
        return { k: 'bin', op: t.id, a: left, b: this.parse(t.s.p) };
      }
      case 'post': return { k: 'post', id: t.id, a: left, dms: !!t.s.dms };
      case 'conv': return { k: 'conv', id: t.id, a: left };
      case 'tpl': return { k: 'pow', a: left, b: parseItems(t.node.a[0], this.ctx) };
      case 'sto': {
        const n = this.next();
        if (!n || n.tt !== 'val' || !(n.s.isVar || n.id === 'rand')) err('SYNTAX');
        if (this.peek()) err('SYNTAX');
        return { k: 'sto', a: left, target: n.id };
      }
    }
    err('SYNTAX');
  }
}

function varOf(items) {
  if (items.length !== 1 || items[0].t || !SYM[items[0].s] || !SYM[items[0].s].isVar) err('SYNTAX');
  return items[0].s;
}

function parseItems(items, ctx) {
  if (!items || !items.length) err('SYNTAX');
  const p = new Parser(lex(items, ctx), ctx);
  const e = p.parse(0);
  if (p.p < p.t.length) err('SYNTAX');
  return e;
}

// ---------------------------------------------------------------- evaluation helpers
function rnum(v) { // real number from a value
  if (!isCx(v)) err('DATA TYPE');
  if (v.im !== 0) err('DATA TYPE');
  return v.re;
}
function rint(v) {
  const x = rnum(v);
  if (!isInt(x)) err('DOMAIN');
  return Math.round(x);
}
const toRad = (x, a) => (a === 'DEG' ? x * PI / 180 : a === 'GRAD' ? x * PI / 200 : x);
const fromRad = (r, a) => (a === 'DEG' ? r * 180 / PI : a === 'GRAD' ? r * 200 / PI : r);
const turns = (x, a) => (a === 'DEG' ? x / 360 : a === 'GRAD' ? x / 400 : x / (2 * PI));
function quarter(x, a) {
  const t = turns(x, a), f = t - Math.floor(t), q = f * 4, qr = Math.round(q);
  return Math.abs(q - qr) < 1e-13 * Math.max(1, Math.abs(t)) ? qr % 4 : -1;
}
function sinA(x, a) { const q = quarter(x, a); if (q >= 0) return [0, 1, 0, -1][q]; return Math.sin(toRad(x, a)); }
function cosA(x, a) { const q = quarter(x, a); if (q >= 0) return [1, 0, -1, 0][q]; return Math.cos(toRad(x, a)); }
function tanA(x, a) {
  const q = quarter(x, a);
  if (q === 1 || q === 3) err('DOMAIN');
  if (q === 0 || q === 2) return 0;
  return Math.tan(toRad(x, a));
}

function factorial(n) {
  if (!isInt(n) || n < 0 || n > 69) err('DOMAIN');
  let r = 1; for (let k = 2; k <= n; k++) r *= k;
  return r;
}
function nCr(n, r) {
  if (!isInt(n) || !isInt(r) || n < 0 || r < 0) err('DOMAIN');
  if (r > n) return 0;
  r = Math.min(r, n - r);
  let v = 1; for (let k = 1; k <= r; k++) v = v * (n - r + k) / k;
  return Math.round(v) === v || v > 1e15 ? v : Math.round(v);
}
function nPr(n, r) {
  if (!isInt(n) || !isInt(r) || n < 0 || r < 0) err('DOMAIN');
  if (r > n) return 0;
  let v = 1; for (let k = 0; k < r; k++) v *= (n - k);
  return v;
}
function roundTo(x, n) {
  const s = Math.sign(x), a = Math.abs(x);
  return s * Number(Math.round(Number(a + 'e' + n)) + 'e-' + n);
}

// Seeded random generator (store an integer to rand to seed it).
function mulberry(st) {
  st.seed = (st.seed + 0x6D2B79F5) >>> 0;
  let t = st.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- matrix helpers
function matMul(A, B) {
  if (A.c !== B.r) err('DIM MISMATCH');
  const R = [];
  for (let i = 0; i < A.r; i++) {
    R.push([]);
    for (let j = 0; j < B.c; j++) {
      let s = 0;
      for (let k = 0; k < A.c; k++) s = addR(s, A.rows[i][k] * B.rows[k][j]);
      R[i].push(s);
    }
  }
  return new Mat(R);
}
function matMap(A, f) { return new Mat(A.rows.map(r => r.map(f))); }
function matZip(A, B, f) {
  if (A.r !== B.r || A.c !== B.c) err('DIM MISMATCH');
  return new Mat(A.rows.map((r, i) => r.map((x, j) => f(x, B.rows[i][j]))));
}
function identity(n) { return new Mat(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))); }
function det(A) {
  if (A.r !== A.c) err('DIM MISMATCH');
  const m = A.rows.map(r => r.slice()), n = A.r;
  let d = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-14) return 0;
    if (p !== c) { [m[p], m[c]] = [m[c], m[p]]; d = -d; }
    d *= m[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k < n; k++) m[r][k] = addR(m[r][k], -f * m[c][k]);
    }
  }
  return d;
}
function matInv(A) {
  if (A.r !== A.c) err('DIM MISMATCH');
  const n = A.r, m = A.rows.map((r, i) => r.concat(identity(n).rows[i]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-13) err('SINGULAR MAT');
    [m[p], m[c]] = [m[c], m[p]];
    const pv = m[c][c];
    for (let k = 0; k < 2 * n; k++) m[c][k] /= pv;
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = m[r][c];
      for (let k = 0; k < 2 * n; k++) m[r][k] = addR(m[r][k], -f * m[c][k]);
    }
  }
  return new Mat(m.map(r => r.slice(n)));
}
// Row echelon form (reduced when full is true), with TI-style leading 1s.
function echelon(A, full) {
  const m = A.rows.map(r => r.slice()), R = A.r, Cn = A.c;
  let row = 0;
  for (let c = 0; c < Cn && row < R; c++) {
    let p = row;
    for (let r = row + 1; r < R; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-13) continue;
    [m[p], m[row]] = [m[row], m[p]];
    const pv = m[row][c];
    for (let k = 0; k < Cn; k++) m[row][k] /= pv;
    for (let r = full ? 0 : row + 1; r < R; r++) if (r !== row) {
      const f = m[r][c];
      for (let k = 0; k < Cn; k++) m[r][k] = addR(m[r][k], -f * m[row][k]);
    }
    row++;
  }
  return new Mat(m.map(r => r.map(x => (Math.abs(x) < 1e-13 ? 0 : x))));
}

// ---------------------------------------------------------------- evaluator
function makeCtx(state) {
  return {
    st: state.settings, vars: state.vars, ans: state.ans, ansApprox: state.ansApprox,
    state, approx: false, usedPi: false, cplx: state.settings.cplx !== 'REAL', depth: 0, opDepth: 0,
  };
}

function scanComplex(items) {
  for (const it of items) {
    if (it.t) { if (it.a.some(scanComplex)) return true; continue; }
    if (it.s === 'i' || it.s === 'angle' || it.s === 'toPolar' || it.s === 'toRect') return true;
  }
  return false;
}

function evaluate(items, state, opts) {
  opts = opts || {};
  const ctx = makeCtx(state);
  if (scanComplex(items)) ctx.cplx = true;
  if (opts.scope) ctx.scope = opts.scope;
  const tree = parseItems(items, ctx);
  let directive = null, node = tree, store = null;
  if (node.k === 'sto') { store = node.target; node = node.a; }
  if (node.k === 'conv') { directive = node.id; node = node.a; }
  let v = ev(node, ctx);
  v = finish(v, ctx);
  if (store) {
    if (store === 'rand') {
      state.rng = { seed: Math.abs(Math.round(rnum(v))) >>> 0 };
    } else {
      if (!isCx(v)) err('DATA TYPE');
      state.vars[store] = v;
      state.varApprox = state.varApprox || {};
      state.varApprox[store] = ctx.approx;
    }
  }
  return { value: v, approx: ctx.approx, usedPi: ctx.usedPi, directive, cplx: ctx.cplx };
}

function finish(v, ctx) {
  if (isCx(v)) {
    v = clean(v);
    if (ctx.st.base !== 'DEC') {
      if (v.im !== 0) err('DATA TYPE');
      v = cx(baseWrap(Math.trunc(v.re), ctx.st.base));
    }
    return v;
  }
  if (v instanceof Mat) return new Mat(v.rows.map(r => r.map(x => round14(checkNum(x)))));
  if (v instanceof Vec) return new Vec(v.a.map(x => round14(checkNum(x))));
  if (v instanceof List) return new List(v.a.map(x => round14(checkNum(x))));
  return v;
}

function baseWrap(n, base) {
  const bits = BASE_BITS[base], M = Math.pow(2, bits);
  if (n >= M / 2 || n < -M / 2) err('OVERFLOW');
  return n;
}

function lookupVal(id, ctx) {
  const s = SYM[id];
  if (s.isVar) {
    if (ctx.scope && id in ctx.scope) return ctx.scope[id];
    if (ctx.state.varApprox && ctx.state.varApprox[id]) ctx.approx = true;
    const v = ctx.vars[id] || cx(0);
    if (v.im !== 0) ctx.cplx = true;
    return v;
  }
  switch (id) {
    case 'pi': ctx.usedPi = true; return cx(PI);
    case 'e': ctx.approx = true; return cx(Math.E);
    case 'i': ctx.cplx = true; return cx(0, 1);
    case 'ans': {
      const a = ctx.state.ans;
      if (ctx.state.ansApprox) ctx.approx = true;
      if (a && a.im) ctx.cplx = true;
      return a || cx(0);
    }
    case 'rand': ctx.approx = true; return cx(mulberry(ctx.state.rng));
  }
  if (s.konst != null) { ctx.approx = true; return cx(s.konst); }
  if (s.stat) {
    const sv = ctx.state.stat;
    if (!sv || sv.vars[id] == null) err('STAT');
    if (typeof sv.vars[id] === 'string') err('DIVIDE BY 0');
    ctx.approx = true;
    return cx(sv.vars[id]);
  }
  if (s.list) {
    const L = ctx.state.lists[id];
    return new List(L.slice());
  }
  if (s.mat) {
    if (id === 'mI2') return identity(2);
    if (id === 'mI3') return identity(3);
    const m = id === 'mAns' ? (ctx.state.ansMat instanceof Mat ? ctx.state.ansMat : null) : ctx.state.mats[id[1]];
    if (!m) err('DATA TYPE');
    return new Mat(m.rows.map(r => r.slice()));
  }
  if (s.vec) {
    const v = id === 'vAns' ? (ctx.state.ansMat instanceof Vec ? ctx.state.ansMat : null) : ctx.state.vecs[id[1].toLowerCase()];
    if (!v) err('DATA TYPE');
    return new Vec(v.a.slice());
  }
  err('SYNTAX');
}

function ev(n, ctx) {
  switch (n.k) {
    case 'num': if (n.approx) ctx.approx = true; return n.v;
    case 'val': return lookupVal(n.id, ctx);
    case 'paren': return ev(n.a, ctx);
    case 'neg': return neg(ev(n.a, ctx), ctx);
    case 'bin': return binop(n.op, ev(n.a, ctx), ev(n.b, ctx), ctx);
    case 'frac': return binop('/', ev(n.n, ctx), ev(n.d, ctx), ctx);
    case 'mixed': {
      let w, f;
      if (n.rest) { w = ev(n.w, ctx); f = ev(n.rest, ctx); }
      else { w = ev(n.w, ctx); f = binop('/', ev(n.n, ctx), ev(n.d, ctx), ctx); }
      const wr = rnum(w), fr = rnum(f);
      return cx(wr < 0 || Object.is(wr, -0) ? wr - fr : wr + fr);
    }
    case 'pow': return power(ev(n.a, ctx), ev(n.b, ctx), ctx);
    case 'sqrt': return sqrtV(ev(n.a, ctx), ctx);
    case 'root': return nthRoot(ev(n.n, ctx), ev(n.a, ctx), ctx);
    case 'exp_e': ctx.approx = true; return mapC(ev(n.a, ctx), z => cExp(z));
    case 'exp_10': return power(cx(10), ev(n.a, ctx), ctx);
    case 'post': return postfix(n.id, ev(n.a, ctx), ctx);
    case 'conv': return ev(n.a, ctx);
    case 'call': return call(n, ctx);
    case 'deriv': return deriv(n.f, n.v, rnum(ev(n.at, ctx)), 1e-3, ctx);
    case 'integ': return integ(n.f, n.v, rnum(ev(n.lo, ctx)), rnum(ev(n.hi, ctx)), ctx);
    case 'sum': case 'prod': return sumProd(n.k, n.f, n.v, ev(n.lo, ctx), ev(n.hi, ctx), ctx);
    case 'matlit': {
      const vals = n.cells.map(c => rnum(ev(c, ctx)));
      const rows = [];
      for (let i = 0; i < n.r; i++) rows.push(vals.slice(i * n.c, i * n.c + n.c));
      return n.r === 1 && n.vec ? new Vec(rows[0]) : new Mat(rows);
    }
    case 'listlit': return new List(n.cells.map(c => rnum(ev(c, ctx))));
    case 'sto': err('SYNTAX');
  }
  err('SYNTAX');
}

function mapC(v, f) {
  if (isCx(v)) return f(v);
  if (v instanceof List) return new List(v.a.map(x => rnum(f(cx(x)))));
  err('DATA TYPE');
}
function mapR(v, f) { // real-valued function, lists mapped
  if (isCx(v)) return cx(f(rnum(v)));
  if (v instanceof List) return new List(v.a.map(f));
  err('DATA TYPE');
}

function neg(v, ctx) {
  if (isCx(v)) return cx(-v.re, -v.im);
  if (v instanceof Mat) return matMap(v, x => -x);
  if (v instanceof Vec) return new Vec(v.a.map(x => -x));
  if (v instanceof List) return new List(v.a.map(x => -x));
  err('DATA TYPE');
}

function binop(op, a, b, ctx) {
  // Lists combine element by element.
  if (a instanceof List || b instanceof List) {
    if (a instanceof List && b instanceof List && a.a.length !== b.a.length) err('DIM MISMATCH');
    const len = a instanceof List ? a.a.length : b.a.length;
    const out = [];
    for (let k = 0; k < len; k++) {
      const x = a instanceof List ? cx(a.a[k]) : a, y = b instanceof List ? cx(b.a[k]) : b;
      out.push(rnum(binop(op, x, y, ctx)));
    }
    return new List(out);
  }
  if (!isCx(a) || !isCx(b)) return binopMat(op, a, b, ctx);
  if (ctx.st.base !== 'DEC' || ['and', 'or', 'xor', 'xnor', 'nand'].includes(op)) {
    const r = baseOp(op, a, b, ctx);
    if (r) return r;
  }
  switch (op) {
    case '+': return cAdd(a, b);
    case '-': return cSub(a, b);
    case '*': return cMul(a, b);
    case '/': return cDiv(a, b);
    case '^': return power(a, b, ctx);
    case 'nCr': return cx(nCr(rnum(a), rnum(b)));
    case 'nPr': return cx(nPr(rnum(a), rnum(b)));
    case 'angle': {
      const r = rnum(a), t = rnum(b);
      ctx.cplx = true;
      return cx(r * cosA(t, ctx.st.angle), r * sinA(t, ctx.st.angle));
    }
  }
  err('SYNTAX');
}

function baseOp(op, a, b, ctx) {
  const base = ctx.st.base;
  const x = Math.trunc(rnum(a)), y = Math.trunc(rnum(b));
  const bits = BASE_BITS[base];
  const toU = n => BigInt.asUintN(bits, BigInt(n));
  const fromU = u => Number(BigInt.asIntN(bits, u));
  const mask = (1n << BigInt(bits)) - 1n;
  switch (op) {
    case 'and': return cx(fromU(toU(x) & toU(y)));
    case 'or': return cx(fromU(toU(x) | toU(y)));
    case 'xor': return cx(fromU(toU(x) ^ toU(y)));
    case 'xnor': return cx(fromU(~(toU(x) ^ toU(y)) & mask));
    case 'nand': return cx(fromU(~(toU(x) & toU(y)) & mask));
    case '/': if (y === 0) err('DIVIDE BY 0'); return cx(Math.trunc(x / y));
    case '+': return cx(x + y);
    case '-': return cx(x - y);
    case '*': return cx(x * y);
  }
  return null;
}

function binopMat(op, a, b, ctx) {
  const A = a, B = b;
  if (op === '+' || op === '-') {
    const f = op === '+' ? addR : (x, y) => addR(x, -y);
    if (A instanceof Mat && B instanceof Mat) return matZip(A, B, f);
    if (A instanceof Vec && B instanceof Vec) {
      if (A.a.length !== B.a.length) err('DIM MISMATCH');
      return new Vec(A.a.map((x, k) => f(x, B.a[k])));
    }
    err('DATA TYPE');
  }
  if (op === '*') {
    if (isCx(A)) { const s = rnum(A); return B instanceof Mat ? matMap(B, x => s * x) : new Vec(B.a.map(x => s * x)); }
    if (isCx(B)) { const s = rnum(B); return A instanceof Mat ? matMap(A, x => s * x) : new Vec(A.a.map(x => s * x)); }
    if (A instanceof Mat && B instanceof Mat) return matMul(A, B);
    if (A instanceof Mat && B instanceof Vec) {
      if (A.c !== B.a.length) err('DIM MISMATCH');
      return new Vec(matMul(A, new Mat(B.a.map(x => [x]))).rows.map(r => r[0]));
    }
    err('DATA TYPE');
  }
  if (op === '/' && isCx(B)) {
    const s = rnum(B); if (s === 0) err('DIVIDE BY 0');
    return A instanceof Mat ? matMap(A, x => x / s) : new Vec(A.a.map(x => x / s));
  }
  if (op === '^' && A instanceof Mat && isCx(B)) return matPow(A, rint(B));
  err('DATA TYPE');
}
function matPow(A, n) {
  if (A.r !== A.c) err('DIM MISMATCH');
  if (n < 0) { A = matInv(A); n = -n; }
  let R = identity(A.r);
  for (let k = 0; k < n; k++) R = matMul(R, A);
  return R;
}

function power(a, b, ctx) {
  if (a instanceof Mat) return matPow(a, rint(b));
  if (a instanceof List || b instanceof List) return binop('^', a, b, ctx);
  if (!isCx(a) || !isCx(b)) err('DATA TYPE');
  if (a.im === 0 && b.im === 0) {
    const x = a.re, y = b.re;
    if (x === 0) {
      if (y === 0) err('DOMAIN');
      if (y < 0) err('DIVIDE BY 0');
      return cx(0);
    }
    if (x > 0 || isInt(y)) {
      if (x === 10 && isInt(y)) return cx(Number('1e' + Math.round(y)));
      return cx(Math.pow(x, isInt(y) ? Math.round(y) : y));
    }
    // negative base with fractional exponent
    if (!ctx.cplx) {
      const r = rat(y, 1000);
      if (r && r[1] % 2 === 1) {
        const m = Math.pow(-x, Math.abs(r[0]) / r[1]);
        const sgn = (Math.abs(r[0]) % 2 === 1) ? -1 : 1;
        return cx(r[0] < 0 ? sgn / m : sgn * m);
      }
      err('DOMAIN');
    }
  }
  if (a.re === 0 && a.im === 0) return cx(0);
  if (b.im === 0 && isInt(b.re) && Math.abs(b.re) <= 64) {
    let n = Math.round(b.re), r = cx(1), base = n < 0 ? cDiv(cx(1), a) : a;
    n = Math.abs(n);
    for (let k = 0; k < n; k++) r = cMul(r, base);
    return r;
  }
  ctx.cplx = true;
  return cExp(cMul(b, cLn(a)));
}

function sqrtV(v, ctx) {
  if (v instanceof List) return mapR(v, x => { if (x < 0) err('DOMAIN'); return Math.sqrt(x); });
  if (!isCx(v)) err('DATA TYPE');
  if (v.im === 0 && v.re < 0 && !ctx.cplx) err('DOMAIN');
  return cSqrt(v);
}
function nthRoot(n, v, ctx) {
  const k = rnum(n), x = rnum(v);
  if (k === 0) err('DOMAIN');
  if (x < 0) {
    if (isInt(k) && Math.round(k) % 2 !== 0) return cx(-Math.pow(-x, 1 / k));
    err('DOMAIN');
  }
  if (isInt(k)) {
    const r = Math.pow(x, 1 / k), rr = Math.round(r);
    // A nonzero radicand cannot have zero as its root. Compare relatively so
    // small roots are not mistaken for exact integers.
    if ((rr !== 0 || x === 0) && Math.abs(Math.pow(rr, k) - x) <= 1e-9 * Math.abs(x) && Math.abs(r - rr) < 1e-9) return cx(rr);
    return cx(r);
  }
  return cx(Math.pow(x, 1 / k));
}

function postfix(id, v, ctx) {
  const s = SYM[id];
  if (s.unit) { ctx.approx = true; return mapR(v, s.unit); }
  const ang = ctx.st.angle;
  switch (id) {
    case 'sq': return v instanceof Mat ? matMul(v, v) : power(v, cx(2), ctx);
    case 'inv':
      if (v instanceof Mat) return matInv(v);
      if (v instanceof List) return mapR(v, x => { if (x === 0) err('DIVIDE BY 0'); return 1 / x; });
      return cDiv(cx(1), v);
    case '!': return mapR(v, factorial);
    case '%': return mapC(v, z => cx(z.re / 100, z.im / 100));
    case 'deg': return mapR(v, x => fromRad(x * PI / 180, ang));
    case 'min': ctx.approx = true; return mapR(v, x => fromRad(x / 60 * PI / 180, ang));
    case 'sec': ctx.approx = true; return mapR(v, x => fromRad(x / 3600 * PI / 180, ang));
    case 'rad': return mapR(v, x => fromRad(x, ang));
    case 'grad': return mapR(v, x => fromRad(x * PI / 200, ang));
    case 'T':
      if (v instanceof Mat) return new Mat(v.rows[0].map((_, j) => v.rows.map(r => r[j])));
      err('DATA TYPE');
    case 'op': return applyOp(v, ctx);
  }
  err('SYNTAX');
}

function applyOp(v, ctx) {
  const op = ctx.state.op;
  if (!op || !op.length) err('OP NOT DEFINED');
  if (ctx.opDepth > 0) err('SYNTAX');
  ctx.opDepth++;
  const toks = [{ tt: 'num', v, approx: false }].concat(lex(op, ctx));
  const p = new Parser(toks, ctx);
  const e = p.parse(0);
  if (p.p < p.t.length) err('SYNTAX');
  const r = ev(e, ctx);
  ctx.opDepth--;
  return r;
}

function argN(n, k) { if (n.args.length !== k) err('ARGUMENT'); }

function call(n, ctx) {
  const id = n.id, A = n.args, st = ctx.st, ang = st.angle;
  const e = k => ev(A[k], ctx);
  const one = () => { argN(n, 1); return e(0); };
  const real1 = f => mapR(one(), f);
  switch (id) {
    case 'sin(': return real1(x => sinA(x, ang));
    case 'cos(': return real1(x => cosA(x, ang));
    case 'tan(': return real1(x => tanA(x, ang));
    case 'asin(': return real1(x => { if (Math.abs(x) > 1) err('DOMAIN'); return fromRad(Math.asin(x), ang); });
    case 'acos(': return real1(x => { if (Math.abs(x) > 1) err('DOMAIN'); return fromRad(Math.acos(x), ang); });
    case 'atan(': return real1(x => fromRad(Math.atan(x), ang));
    case 'sinh(': ctx.approx = true; return real1(Math.sinh);
    case 'cosh(': ctx.approx = true; return real1(Math.cosh);
    case 'tanh(': ctx.approx = true; return real1(Math.tanh);
    case 'asinh(': ctx.approx = true; return real1(Math.asinh);
    case 'acosh(': ctx.approx = true; return real1(x => { if (x < 1) err('DOMAIN'); return Math.acosh(x); });
    case 'atanh(': ctx.approx = true; return real1(x => { if (Math.abs(x) >= 1) err('DOMAIN'); return Math.atanh(x); });
    case 'ln(': case 'log(': {
      const v = one();
      const isLog = id === 'log(';
      const f = z => {
        if (z.im === 0 && z.re > 0) {
          if (isLog) {
            const l = Math.log10(z.re);
            if (!isInt(l)) ctx.approx = true;
            return cx(isInt(l) ? Math.round(l) : l);
          }
          ctx.approx = true;
          return cx(Math.log(z.re));
        }
        if (z.re === 0 && z.im === 0) err('DOMAIN');
        if (!ctx.cplx) err('DOMAIN');
        ctx.approx = true;
        const l = cLn(z);
        return isLog ? cx(l.re / Math.LN10, l.im / Math.LN10) : l;
      };
      return mapC(v, f);
    }
    case 'csqrt(': return sqrtV(one(), ctx);
    case 'cexp(': ctx.approx = true; return mapC(one(), cExp);
    case 'c10(': return power(cx(10), one(), ctx);
    case 'abs(': {
      const v = one();
      if (v instanceof List) return mapR(v, Math.abs);
      if (!isCx(v)) err('DATA TYPE');
      return cx(cAbs(v));
    }
    case 'round(': {
      if (A.length < 1 || A.length > 2) err('ARGUMENT');
      const d = A.length === 2 ? rint(e(1)) : 9;
      if (d < 0 || d > 9) err('DOMAIN');
      return mapR(e(0), x => roundTo(x, d));
    }
    case 'iPart(': return real1(Math.trunc);
    case 'fPart(': return real1(x => addR(x, -Math.trunc(x)));
    case 'int(': return real1(x => Math.floor(round14(x)));
    case 'min(': argN(n, 2); return cx(Math.min(rnum(e(0)), rnum(e(1))));
    case 'max(': argN(n, 2); return cx(Math.max(rnum(e(0)), rnum(e(1))));
    case 'mod(': {
      argN(n, 2);
      const a = rnum(e(0)), b = rnum(e(1));
      if (b === 0) err('DIVIDE BY 0');
      return cx(addR(a, -b * Math.floor(round14(a / b))));
    }
    case 'lcm(': case 'gcd(': {
      argN(n, 2);
      const a = rint(e(0)), b = rint(e(1));
      if (id === 'gcd(') return cx(gcd(a, b));
      return cx(a === 0 || b === 0 ? 0 : Math.abs(a * b) / gcd(a, b));
    }
    case 'PRx(': argN(n, 2); return cx(rnum(e(0)) * cosA(rnum(e(1)), ang));
    case 'PRy(': argN(n, 2); return cx(rnum(e(0)) * sinA(rnum(e(1)), ang));
    case 'RPr(': argN(n, 2); return cx(Math.hypot(rnum(e(0)), rnum(e(1))));
    case 'RPt(': {
      argN(n, 2);
      const x = rnum(e(0)), y = rnum(e(1));
      if (x === 0 && y === 0) err('DOMAIN');
      return cx(fromRad(Math.atan2(y, x), ang));
    }
    case 'randint(': {
      argN(n, 2);
      let a = rint(e(0)), b = rint(e(1));
      if (a > b) [a, b] = [b, a];
      return cx(a + Math.floor(mulberry(ctx.state.rng) * (b - a + 1)));
    }
    case 'nDeriv(': {
      if (A.length < 3 || A.length > 4) err('ARGUMENT');
      const v = A[1].k === 'val' && SYM[A[1].id].isVar ? A[1].id : err('SYNTAX');
      const h = A.length === 4 ? rnum(e(3)) : 1e-3;
      return deriv(A[0], v, rnum(e(2)), h, ctx);
    }
    case 'fnInt(': {
      argN(n, 4);
      const v = A[1].k === 'val' && SYM[A[1].id].isVar ? A[1].id : err('SYNTAX');
      return integ(A[0], v, rnum(e(2)), rnum(e(3)), ctx);
    }
    case 'sum(': case 'prod(': argN(n, 3); return sumProd(id === 'sum(' ? 'sum' : 'prod', A[0], 'x', e(1), e(2), ctx);
    case 'det(': { const m = one(); if (!(m instanceof Mat)) err('DATA TYPE'); return cx(det(m)); }
    case 'ref(': case 'rref(': { const m = one(); if (!(m instanceof Mat)) err('DATA TYPE'); return echelon(m, id === 'rref('); }
    case 'DotP(': {
      argN(n, 2);
      const u = e(0), w = e(1);
      if (!(u instanceof Vec) || !(w instanceof Vec)) err('DATA TYPE');
      if (u.a.length !== w.a.length) err('DIM MISMATCH');
      return cx(u.a.reduce((s, x, k) => addR(s, x * w.a[k]), 0));
    }
    case 'CrossP(': {
      argN(n, 2);
      const u = e(0), w = e(1);
      if (!(u instanceof Vec) || !(w instanceof Vec)) err('DATA TYPE');
      if (u.a.length !== w.a.length || u.a.length < 2) err('DIM MISMATCH');
      const [a1, a2, a3 = 0] = u.a, [b1, b2, b3 = 0] = w.a;
      return new Vec([addR(a2 * b3, -a3 * b2), addR(a3 * b1, -a1 * b3), addR(a1 * b2, -a2 * b1)]);
    }
    case 'norm(': {
      const v = one();
      if (v instanceof Vec) return cx(Math.hypot(...v.a));
      if (v instanceof Mat) return cx(Math.sqrt(v.rows.flat().reduce((s, x) => s + x * x, 0)));
      err('DATA TYPE');
    }
    case 'angle(': { const v = one(); if (!isCx(v)) err('DATA TYPE'); return cx(fromRad(cArg(v), ang)); }
    case 'conj(': { const v = one(); if (!isCx(v)) err('DATA TYPE'); ctx.cplx = true; return cx(v.re, -v.im); }
    case 'real(': { const v = one(); if (!isCx(v)) err('DATA TYPE'); return cx(v.re); }
    case 'imag(': { const v = one(); if (!isCx(v)) err('DATA TYPE'); return cx(v.im); }
    case 'not(': { const x = Math.trunc(rnum(one())); return cx(-x - 1); }
    case 'twos(': { const x = Math.trunc(rnum(one())); return cx(-x); }
    case 'f(': {
      argN(n, 1);
      const fx = ctx.state.fx;
      if (!fx || !fx.length) err('INVALID FUNCTION');
      return evalWith(parseItems(fx, ctx), { x: e(0) }, ctx);
    }
    case 'S_xp(': case 'S_yp(': {
      argN(n, 1);
      const sv = ctx.state.stat;
      if (!sv || sv.vars.S_a == null || sv.lin !== true) err('STAT');
      ctx.approx = true;
      const a = sv.vars.S_a, b = sv.vars.S_b, t = rnum(e(0));
      if (id === 'S_yp(') return cx(a * t + b);
      if (a === 0) err('DIVIDE BY 0');
      return cx((t - b) / a);
    }
  }
  err('SYNTAX');
}

function evalWith(tree, scope, ctx) {
  const old = ctx.scope;
  ctx.scope = Object.assign({}, old || {}, scope);
  try { return ev(tree, ctx); } finally { ctx.scope = old; }
}
function fReal(tree, v, ctx) {
  return x => {
    const r = evalWith(tree, { [v]: cx(x) }, ctx);
    return rnum(r);
  };
}

function deriv(tree, v, at, h, ctx) {
  ctx.approx = true;
  if (ctx.inDeriv) err('SYNTAX');
  ctx.inDeriv = true;
  try {
    const f = fReal(tree, v, ctx);
    if (h === 0) err('DOMAIN');
    return cx((f(at + h) - f(at - h)) / (2 * h));
  } finally { ctx.inDeriv = false; }
}

// Adaptive Gauss-Kronrod (7/15) integration.
const GK = {
  x: [0.991455371120812639, 0.949107912342758525, 0.864864423359769073, 0.741531185599394440,
    0.586087235467691130, 0.405845151377397167, 0.207784955007898468, 0],
  wk: [0.022935322010529225, 0.063092092629978553, 0.104790010322250184, 0.140653259715525919,
    0.169004726639267903, 0.190350578064785410, 0.204432940075298892, 0.209482141084727828],
  wg: [0, 0.129484966168869693, 0, 0.279705391489276668, 0, 0.381830050505118945, 0, 0.417959183673469388],
};
function gk15(f, a, b) {
  const c = (a + b) / 2, h = (b - a) / 2;
  let k = 0, g = 0;
  for (let j = 0; j < 8; j++) {
    if (j === 7) { const y = f(c); k += GK.wk[7] * y; g += GK.wg[7] * y; continue; }
    const dx = h * GK.x[j], y1 = f(c - dx), y2 = f(c + dx);
    k += GK.wk[j] * (y1 + y2); g += GK.wg[j] * (y1 + y2);
  }
  return [k * h, Math.abs((k - g) * h)];
}
function integ(tree, v, a, b, ctx) {
  ctx.approx = true;
  if (ctx.inInteg) err('SYNTAX');
  ctx.inInteg = true;
  try {
    const f = fReal(tree, v, ctx);
    if (a === b) return cx(0);
    let sign = 1;
    if (a > b) { [a, b] = [b, a]; sign = -1; }
    let total = 0, evals = 0;
    const stack = [[a, b, 0]];
    const whole = gk15(f, a, b)[0];
    const tol = 1e-11 * Math.max(1, Math.abs(whole));
    while (stack.length) {
      const [x0, x1, depth] = stack.pop();
      const [val, e] = gk15(f, x0, x1);
      evals++;
      if (e <= tol * (x1 - x0) / (b - a) || depth > 40 || evals > 4000) {
        if (evals > 4000 && e > 1e-6 * Math.max(1, Math.abs(val))) err('TOL NOT MET');
        total += val;
      } else {
        const m = (x0 + x1) / 2;
        stack.push([x0, m, depth + 1], [m, x1, depth + 1]);
      }
    }
    return cx(sign * total);
  } finally { ctx.inInteg = false; }
}

function sumProd(kind, tree, v, lo, hi, ctx) {
  let a = rnum(lo), b = rnum(hi);
  if (!isInt(a) || !isInt(b)) err('DOMAIN');
  a = Math.round(a); b = Math.round(b);
  if (a > b) err('ARGUMENT');
  if (b - a > 100000) err('ARGUMENT');
  let acc = kind === 'sum' ? cx(0) : cx(1);
  for (let k = a; k <= b; k++) {
    const t = evalWith(tree, { [v]: cx(k) }, ctx);
    if (!isCx(t)) err('DATA TYPE');
    acc = kind === 'sum' ? cAdd(acc, t) : cMul(acc, t);
  }
  return acc;
}

// ---------------------------------------------------------------- statistics
function median(a) { const n = a.length; if (!n) return NaN; const m = n >> 1; return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }

function statData(state, xl, fl, yl) {
  const lists = state.lists || {};
  const X = lists[xl], Y = yl ? lists[yl] : null;
  const hasF = fl && fl !== 'ONE', F = hasF ? lists[fl] : null;
  if (!Array.isArray(X) || !X.length || X.length > 42) err('STAT');
  if (yl && (!Array.isArray(Y) || Y.length !== X.length)) err('STAT');
  if (hasF && (!Array.isArray(F) || F.length !== X.length)) err('STAT');
  // Iterate cells explicitly: Array.every/some would skip sparse grid holes.
  for (let k = 0; k < X.length; k++) {
    if (typeof X[k] !== 'number' || !Number.isFinite(X[k]) ||
        (Y && (typeof Y[k] !== 'number' || !Number.isFinite(Y[k])))) err('STAT');
    if (F) {
      if (F[k] == null) err('STAT');
      if (typeof F[k] !== 'number' || !Number.isFinite(F[k]) || F[k] < 0) err('FRQ DOMAIN');
    }
  }
  return { X, Y, F: F || X.map(() => 1) };
}

function oneVar(state, xl, fl) {
  const { X, F } = statData(state, xl, fl);
  let n = 0, sx = 0, sx2 = 0;
  X.forEach((x, k) => { n += F[k]; sx += F[k] * x; sx2 += F[k] * x * x; });
  if (n === 0) err('STAT');
  const mean = sx / n;
  let ss = 0;
  X.forEach((x, k) => { ss += F[k] * (x - mean) * (x - mean); });
  const intF = F.every(f => Number.isInteger(f));
  let min, q1, med, q3, max;
  if (intF) {
    // Sort at most 42 distinct input rows, never one row per observation.
    // BigInt keeps parity and ranks exact even for integer frequencies > 2^53.
    const sorted = X.map((x, k) => ({ x, count: BigInt(F[k]) })).filter(p => p.count > 0n).sort((a, b) => a.x - b.x);
    const N = sorted.reduce((total, p) => total + p.count, 0n), h = N / 2n;
    const at = rank => {
      for (const p of sorted) { if (rank < p.count) return p.x; rank -= p.count; }
    };
    const middle = (start, length) => {
      const rank = start + length / 2n;
      return length % 2n ? at(rank) : (at(rank - 1n) + at(rank)) / 2;
    };
    min = sorted[0].x; max = sorted[sorted.length - 1].x;
    med = middle(0n, N);
    q1 = N === 1n ? min : middle(0n, h);
    q3 = N === 1n ? min : middle(N - h, h);
  } else {
    // Preserve the existing fractional-frequency quartile convention.
    const sorted = X.slice().sort((a, b) => a - b), N = sorted.length, h = N >> 1;
    min = sorted[0]; max = sorted[N - 1]; med = median(sorted);
    q1 = N > 1 ? median(sorted.slice(0, h)) : min;
    q3 = N > 1 ? median(sorted.slice(N % 2 ? h + 1 : h)) : min;
  }
  const vars = {
    S_n: n, S_xbar: mean,
    S_Sx: (n > 1 && intF) ? Math.sqrt(ss / (n - 1)) : 'Error',
    S_sx: Math.sqrt(ss / n), S_Sumx: sx, S_Sumx2: sx2,
    S_minX: min, S_Q1: q1, S_Med: med, S_Q3: q3, S_maxX: max,
  };
  const order = ['S_n', 'S_xbar', 'S_Sx', 'S_sx', 'S_Sumx', 'S_Sumx2', 'S_minX', 'S_Q1', 'S_Med', 'S_Q3', 'S_maxX'];
  return { title: '1-Var Stats', vars, order };
}

function twoVarCore(X, Y, F) {
  let n = 0, sx = 0, sy = 0, sx2 = 0, sy2 = 0, sxy = 0;
  X.forEach((x, k) => {
    const f = F[k], y = Y[k];
    n += f; sx += f * x; sy += f * y; sx2 += f * x * x; sy2 += f * y * y; sxy += f * x * y;
  });
  if (n === 0) err('STAT');
  const xb = sx / n, yb = sy / n;
  let ssx = 0, ssy = 0, sxyc = 0;
  X.forEach((x, k) => { const f = F[k], y = Y[k]; ssx += f * (x - xb) ** 2; ssy += f * (y - yb) ** 2; sxyc += f * (x - xb) * (y - yb); });
  const a = ssx === 0 ? NaN : sxyc / ssx;
  const b = yb - a * xb;
  const r = (ssx === 0 || ssy === 0) ? NaN : sxyc / Math.sqrt(ssx * ssy);
  return { n, sx, sy, sx2, sy2, sxy, xb, yb, ssx, ssy, a, b, r };
}

function twoVar(state, xl, yl, fl) {
  const { X, Y, F } = statData(state, xl, fl, yl);
  const c = twoVarCore(X, Y, F);
  const intF = F.every(f => Number.isInteger(f));
  if (c.ssx === 0) err('DIVIDE BY 0');
  const vars = {
    S_n: c.n, S_xbar: c.xb, S_Sx: (c.n > 1 && intF) ? Math.sqrt(c.ssx / (c.n - 1)) : 'Error', S_sx: Math.sqrt(c.ssx / c.n),
    S_Sumx: c.sx, S_Sumx2: c.sx2,
    S_ybar: c.yb, S_Sy: (c.n > 1 && intF) ? Math.sqrt(c.ssy / (c.n - 1)) : 'Error', S_sy: Math.sqrt(c.ssy / c.n),
    S_Sumy: c.sy, S_Sumy2: c.sy2, S_Sumxy: c.sxy,
    S_a: c.a, S_b: c.b, S_r2: isNaN(c.r) ? 'Error' : c.r * c.r, S_r: isNaN(c.r) ? 'Error' : c.r,
    S_minX: Math.min(...X), S_maxX: Math.max(...X), S_minY: Math.min(...Y), S_maxY: Math.max(...Y),
  };
  const order = ['S_n', 'S_xbar', 'S_Sx', 'S_sx', 'S_Sumx', 'S_Sumx2', 'S_ybar', 'S_Sy', 'S_sy', 'S_Sumy', 'S_Sumy2',
    'S_Sumxy', 'S_a', 'S_b', 'S_r2', 'S_r', 'S_xp(', 'S_yp(', 'S_minX', 'S_maxX', 'S_minY', 'S_maxY'];
  return { title: '2-Var Stats', vars, order, lin: true };
}

function solveLinear(M, rhs) {
  const n = M.length, m = M.map((r, i) => r.concat([rhs[i]]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) err('SINGULAR MAT');
    [m[p], m[c]] = [m[c], m[p]];
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((r, i) => r[n] / r[i]);
}

function regression(state, kind, xl, yl, fl) {
  const { X, Y, F } = statData(state, xl, fl, yl);
  const base = twoVar(state, xl, yl, fl);
  const vars = Object.assign({}, base.vars);
  const order = base.order.slice();
  let eq, title, lin = false;
  const transform = (fx, fy) => {
    const tx = X.map(fx), ty = Y.map(fy);
    return twoVarCore(tx, ty, F);
  };
  if (kind === 'lin') {
    title = 'LinReg ax+b'; lin = true;
    eq = { type: 'lin', a: vars.S_a, b: vars.S_b };
  } else if (kind === 'quad' || kind === 'cubic') {
    const deg = kind === 'quad' ? 2 : 3;
    const nPts = X.length;
    if (nPts < deg + 1) err('DIM MISMATCH');
    const S = [], T = [];
    for (let i = 0; i <= deg; i++) {
      S.push([]);
      for (let j = 0; j <= deg; j++) S[i].push(X.reduce((s, x, k) => s + F[k] * Math.pow(x, 2 * deg - i - j), 0));
      T.push(X.reduce((s, x, k) => s + F[k] * Math.pow(x, deg - i) * Y[k], 0));
    }
    const coef = solveLinear(S, T);
    const yb = base.vars.S_ybar;
    let ssr = 0, sst = 0;
    X.forEach((x, k) => {
      const yhat = coef.reduce((s, c, i) => s + c * Math.pow(x, deg - i), 0);
      ssr += F[k] * (Y[k] - yhat) ** 2; sst += F[k] * (Y[k] - yb) ** 2;
    });
    ['S_a', 'S_b', 'S_c', 'S_d'].slice(0, deg + 1).forEach((k, i) => { vars[k] = coef[i]; });
    vars.S_R2 = sst === 0 ? 1 : 1 - ssr / sst;
    delete vars.S_r; delete vars.S_r2;
    title = kind === 'quad' ? 'QuadraticReg' : 'CubicReg';
    eq = { type: kind, coef };
  } else {
    let c;
    if (kind === 'ln') {
      if (X.some(x => x <= 0)) err('DOMAIN');
      c = transform(Math.log, y => y); title = 'LnReg a+blnx';
      vars.S_a = c.b; vars.S_b = c.a; eq = { type: 'ln', a: c.b, b: c.a };
    } else if (kind === 'pwr') {
      if (X.some(x => x <= 0) || Y.some(y => y <= 0)) err('DOMAIN');
      c = transform(Math.log, Math.log); title = 'PwrReg ax^b';
      vars.S_a = Math.exp(c.b); vars.S_b = c.a; eq = { type: 'pwr', a: vars.S_a, b: vars.S_b };
    } else {
      if (Y.some(y => y <= 0)) err('DOMAIN');
      c = transform(x => x, Math.log); title = 'ExpReg ab^x';
      vars.S_a = Math.exp(c.b); vars.S_b = Math.exp(c.a); eq = { type: 'exp', a: vars.S_a, b: vars.S_b };
    }
    vars.S_r = c.r; vars.S_r2 = c.r * c.r;
  }
  const head = kind === 'quad' ? ['S_a', 'S_b', 'S_c', 'S_R2'] : kind === 'cubic' ? ['S_a', 'S_b', 'S_c', 'S_d', 'S_R2'] : ['S_a', 'S_b', 'S_r2', 'S_r'];
  const isPredict = k => k === 'S_xp(' || k === 'S_yp(';
  const rest = order.filter(k => !head.includes(k) && (isPredict(k) ? lin : vars[k] !== undefined));
  return { title, vars, order: head.concat(rest), lin, eq };
}

function regEqItems(eq) {
  const num = x => numItems(x, { notation: 'NORM', fix: null, mathprint: true }, false);
  const plus = x => (x < 0 ? [{ s: '-' }].concat(num(-x)) : [{ s: '+' }].concat(num(x)));
  const X = { s: 'x' };
  switch (eq.type) {
    case 'lin': return num(eq.a).concat([{ s: '*' }, X], plus(eq.b));
    case 'quad': case 'cubic': {
      const deg = eq.coef.length - 1;
      let out = [];
      eq.coef.forEach((c, i) => {
        const p = deg - i;
        const term = p === 0 ? [] : p === 1 ? [{ s: '*' }, X] : [{ s: '*' }, X, { t: 'pow', a: [[{ s: String(p) }]] }];
        out = out.concat(i === 0 ? num(c) : plus(c), term);
      });
      return out;
    }
    case 'ln': return num(eq.a).concat(eq.b < 0 ? [{ s: '-' }].concat(num(-eq.b)) : [{ s: '+' }].concat(num(eq.b)), [{ s: '*' }, { s: 'ln(' }, X, { s: ')' }]);
    case 'pwr': return num(eq.a).concat([{ s: '*' }, X, { t: 'pow', a: [num(eq.b)] }]);
    case 'exp': return num(eq.a).concat([{ s: '*' }, { s: '(' }], num(eq.b), [{ s: ')' }, { t: 'pow', a: [[X]] }]);
  }
  return [];
}

// ---------------------------------------------------------------- distributions
function erfcPos(x) { // x >= 0
  if (x < 3) {
    // erf via series with all-positive terms: erf(x) = 2/sqrt(pi) e^{-x^2} sum 2^n x^{2n+1}/(2n+1)!!
    let term = x, sum = x;
    for (let n = 1; n < 200; n++) {
      term *= 2 * x * x / (2 * n + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return 1 - 2 / Math.sqrt(PI) * Math.exp(-x * x) * sum;
  }
  // continued fraction, evaluated from the tail
  let f = x;
  for (let k = 60; k >= 1; k--) f = x + (k / 2) / f;
  return Math.exp(-x * x) / Math.sqrt(PI) / f;
}
function erfc(x) { return x >= 0 ? erfcPos(x) : 2 - erfcPos(-x); }
function phi(z) { return 0.5 * erfc(-z / Math.SQRT2); }
function normalPdf(x, mu, s) { if (!(s > 0)) err('sigma>0 sigma Real'); const z = (x - mu) / s; return Math.exp(-z * z / 2) / (s * Math.sqrt(2 * PI)); }
function normalCdf(lo, hi, mu, s) {
  if (!(s > 0)) err('sigma>0 sigma Real');
  if (lo > hi) err('ARGUMENT');
  const a = (lo - mu) / s, b = (hi - mu) / s;
  if (a > 0) return phi(-a) - phi(-b);
  return phi(b) - phi(a);
}
function invNorm(p, mu, s) {
  if (!(p > 0 && p < 1)) err('0<area<1');
  if (!(s > 0)) err('sigma>0 sigma Real');
  // Acklam's approximation followed by Newton refinement
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  let z;
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); z = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); z = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else { const q = p - 0.5, r = q * q; z = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  for (let k = 0; k < 3; k++) {
    const e = phi(z) - p;
    z -= e / (Math.exp(-z * z / 2) / Math.sqrt(2 * PI));
  }
  return mu + s * z;
}
function binomPdf(n, p, x) {
  if (!isInt(n) || n <= 0 || n >= 41) err('Number of trials 0<n<41');
  if (!(p >= 0 && p <= 1)) err('Probability 0<p<1');
  if (!isInt(x) || x < 0) err('Input must be non-negative integer');
  if (x > n) return 0;
  return nCr(n, x) * Math.pow(p, x) * Math.pow(1 - p, n - x);
}
function binomCdf(n, p, x) {
  binomPdf(n, p, 0);
  if (!isInt(x) || x < 0) err('Input must be non-negative integer');
  let s = 0; for (let k = 0; k <= Math.min(x, n); k++) s += binomPdf(n, p, k);
  return Math.min(1, s);
}
function poissonPdf(mu, x) {
  if (!(mu > 0)) err('Mean mu>0');
  if (!isInt(x) || x < 0) err('Input must be non-negative integer');
  let lg = -mu + x * Math.log(mu);
  for (let k = 2; k <= x; k++) lg -= Math.log(k);
  return Math.exp(lg);
}
function poissonCdf(mu, x) {
  poissonPdf(mu, 0);
  if (!isInt(x) || x < 0) err('Input must be non-negative integer');
  let s = 0; for (let k = 0; k <= x; k++) s += poissonPdf(mu, k);
  return Math.min(1, s);
}

// ---------------------------------------------------------------- solvers
function ratOf(x) { const r = rat(x, 100000, 1e-12 * Math.max(1, Math.abs(x))); return r; }
function lcm(a, b) { return a / gcd(a, b) * b; }

// Quadratic roots with exact forms when coefficients are rational.
function quadSolve(a, b, c, st) {
  if (a === 0) err('Highest Degree coefficient cannot be zero');
  const D = b * b - 4 * a * c;
  const sq = Math.sqrt(Math.abs(D));
  let r1, r2;
  if (D >= 0) {
    const q = -0.5 * (b + (b >= 0 ? sq : -sq));
    const x1 = q / a, x2 = q === 0 ? 0 : c / q;
    // x1 is the root with + sign in (-b ± sqrt(D))/(2a)
    const plus = (-b + sq) / (2 * a);
    [r1, r2] = Math.abs(x1 - plus) <= Math.abs(x2 - plus) ? [x1, x2] : [x2, x1];
    r1 = cx(round14(r1)); r2 = cx(round14(r2));
  } else {
    const re = -b / (2 * a), im = sq / (2 * Math.abs(a));
    r1 = cx(round14(re), round14(im)); r2 = cx(round14(re), round14(-im));
  }
  const h = -b / (2 * a), k = c - b * b / (4 * a);
  return { roots: [r1, r2], exact: quadExact(a, b, c, st), h: round14(h), k: round14(k), D: round14(D) };
}
function quadExact(a, b, c, st) {
  const ra = ratOf(a), rb = ratOf(b), rc = ratOf(c);
  if (!ra || !rb || !rc) return null;
  const L = lcm(lcm(ra[1], rb[1]), rc[1]);
  const A = ra[0] * L / ra[1], B = rb[0] * L / rb[1], C = rc[0] * L / rc[1];
  const D = B * B - 4 * A * C;
  if (!Number.isSafeInteger(D) || Math.abs(D) > 1e12) return null;
  const [s, r] = sqfree(Math.abs(D));
  const den = 2 * A;
  const build = sign => {
    if (r === 1 && D >= 0) return numItemsExact((-B + sign * s) / den, st);
    // (-B ± s√r [i]) / den
    let p = -B, q = sign * s, d = den;
    const g = gcd(gcd(Math.abs(p), Math.abs(q)), Math.abs(d)) || 1;
    p /= g; q /= g; d /= g;
    if (d < 0) { p = -p; q = -q; d = -d; }
    const rad = r === 1 ? [] : radicalCore(Math.abs(q), r, st);
    if (D < 0) {
      // real part p/d, imaginary part q√r/d
      const re = p === 0 ? [] : numItemsExact(p / d, st);
      const imMag = imagPart(Math.abs(q), r, d, st);
      return re.concat(q < 0 ? [{ s: '-' }] : (re.length ? [{ s: '+' }] : []), imMag, [{ s: 'i' }]);
    }
    const numer = (p === 0 ? [] : intItems(p)).concat(q < 0 ? [{ s: '-' }] : (p === 0 ? [] : [{ s: '+' }]), rad);
    if (d === 1) return numer;
    return fracItems(numer, intItems(d), st);
  };
  return [build(1), build(-1)];
}
function imagPart(q, r, d, st) {
  const core = r === 1 ? intItems(q) : radicalCore(q, r, st);
  if (d === 1) return r === 1 && q === 1 ? [] : core;
  return fracItems(core, intItems(d), st);
}
function radicalCore(coef, r, st) {
  const out = coef === 1 ? [] : intItems(coef);
  if (st.mathprint) out.push({ t: 'sqrt', a: [intItems(r)] });
  else out.push({ s: 'csqrt(' }, ...intItems(r), { s: ')' });
  return out;
}

// Confirm a repeated root exactly for binary64 or displayed decimal coefficients.
// A floating-point discriminant tolerance alone can erase a close complex pair.
function cubicMultiplicity(a, b, c, d) {
  const view = new DataView(new ArrayBuffer(8));
  const parts = [a, b, c, d].map(x => {
    view.setFloat64(0, x);
    const hi = view.getUint32(0), lo = view.getUint32(4);
    const exponent = (hi >>> 20) & 2047;
    let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    if (exponent) m |= 1n << 52n;
    return { m: hi >>> 31 ? -m : m, e: exponent ? exponent - 1075 : -1074 };
  });
  const e = Math.min(...parts.filter(p => p.m !== 0n).map(p => p.e));
  const binary = exactCubicMultiplicity(parts.map(p => p.m << BigInt(p.e - e)));
  if (binary) return binary;
  const decimal = [a, b, c, d].map(x => {
    const [mantissa, exponent = '0'] = String(x).toLowerCase().split('e');
    const point = mantissa.indexOf('.');
    const places = point < 0 ? 0 : mantissa.length - point - 1;
    return { m: BigInt(mantissa.replace('.', '')), e: Number(exponent) - places };
  });
  const decimalExponent = Math.min(...decimal.filter(p => p.m !== 0n).map(p => p.e));
  return exactCubicMultiplicity(decimal.map(p => p.m === 0n ? 0n : p.m * 10n ** BigInt(p.e - decimalExponent)));
}

function exactCubicMultiplicity([A, B, C, D]) {
  const delta0 = B * B - 3n * A * C;
  const delta1 = 2n * B * B * B - 9n * A * B * C + 27n * A * A * D;
  if (delta1 * delta1 !== 4n * delta0 * delta0 * delta0) return null;
  // Form the repeated root from exact invariants too: floating subtraction
  // loses delta0 when a double root is very close to the remaining root.
  const significant = n => {
    const abs = n < 0n ? -n : n;
    const shift = Math.max(0, abs.toString(2).length - 53);
    return { value: Number(abs >> BigInt(shift)) * (n < 0n ? -1 : 1), shift };
  };
  const ratio = (n, d) => {
    const numerator = significant(n), denominator = significant(d);
    return numerator.value / denominator.value * Math.pow(2, numerator.shift - denominator.shift);
  };
  if (delta0 === 0n) return { multiplicity: 3, repeated: ratio(-B, 3n * A) };
  const repeated = ratio(9n * A * D - B * C, 2n * delta0);
  return { multiplicity: 2, repeated, simple: ratio(-B, A) - 2 * repeated };
}

function cubicSolve(a, b, c, d) {
  if (a === 0) err('Highest Degree coefficient cannot be zero');
  // Scale coefficients before forming invariants to avoid overflow/underflow.
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  const A = a / scale, B0 = b / scale, C0 = c / scale, D0 = d / scale;
  const delta0 = B0 * B0 - 3 * A * C0;
  const delta1 = 2 * B0 * B0 * B0 - 9 * A * B0 * C0 + 27 * A * A * D0;
  const discriminant = delta1 * delta1 - 4 * delta0 * delta0 * delta0;
  const scale0 = B0 * B0 + 3 * Math.abs(A * C0);
  const scale1 = 2 * Math.abs(B0 * B0 * B0) + 9 * Math.abs(A * B0 * C0) + 27 * Math.abs(A * A * D0);
  if (Math.abs(discriminant) <= 64 * Number.EPSILON * (scale1 * scale1 + 4 * scale0 * scale0 * scale0)) {
    const repeatedRoot = cubicMultiplicity(a, b, c, d);
    if (repeatedRoot && repeatedRoot.multiplicity === 3) {
      const repeated = round14(repeatedRoot.repeated);
      return [cx(repeated), cx(repeated), cx(repeated)];
    }
    if (repeatedRoot && repeatedRoot.multiplicity === 2) {
      const repeated = repeatedRoot.repeated;
      return [cx(round14(repeatedRoot.simple)), cx(round14(repeated)), cx(round14(repeated))];
    }
  }
  const f = x => ((a * x + b) * x + c) * x + d;
  const fp = x => (3 * a * x + 2 * b) * x + c;
  // bracket a real root
  const bound = 1 + Math.max(Math.abs(b / a), Math.abs(c / a), Math.abs(d / a));
  let lo = -bound, hi = bound;
  if (f(lo) > 0) [lo, hi] = [hi, lo];
  let x = 0;
  for (let k = 0; k < 200; k++) {
    x = (lo + hi) / 2;
    const v = f(x);
    if (v === 0) break;
    if (v < 0) lo = x; else hi = x;
  }
  for (let k = 0; k < 5; k++) { const dv = fp(x); if (dv === 0) break; const nx = x - f(x) / dv; if (!isFinite(nx)) break; x = nx; }
  // deflate: a x^2 + B x + C
  const B = b + a * x, C = c + B * x;
  const q = quadSolve(a, B, C, { mathprint: true });
  const roots = [cx(round14(x)), q.roots[0], q.roots[1]];
  // polish real roots
  return roots.map(r => {
    if (r.im !== 0) return r;
    let y = r.re;
    for (let k = 0; k < 3; k++) { const dv = fp(y); if (dv === 0) break; const ny = y - f(y) / dv; if (isFinite(ny)) y = ny; }
    return cx(round14(y));
  }).sort((p, s) => (p.im === 0 && s.im !== 0 ? -1 : p.im !== 0 && s.im === 0 ? 1 : 0));
}

// Linear system: returns {type:'unique', x:[...]}, {type:'none'} or {type:'inf', exprs:[items...]}
function linSystem(M) { // M: n rows of n+1 numbers
  const n = M.length;
  const R = echelon(new Mat(M.map(r => r.slice())), true).rows;
  // inconsistency
  for (const row of R) {
    if (row.slice(0, n).every(v => Math.abs(v) < 1e-12) && Math.abs(row[n]) > 1e-12) return { type: 'none' };
  }
  const pivots = [];
  R.forEach((row, i) => { const p = row.slice(0, n).findIndex(v => Math.abs(v) > 1e-12); if (p >= 0) pivots.push([i, p]); });
  if (pivots.length === n) {
    const x = new Array(n).fill(0);
    pivots.forEach(([i, p]) => { x[p] = round14(R[i][n]); });
    return { type: 'unique', x };
  }
  return { type: 'inf', R, pivots };
}
function linInfiniteItems(sol, names, st) {
  const n = names.length, pivotCols = sol.pivots.map(p => p[1]);
  return names.map((nm, col) => {
    const pv = sol.pivots.find(p => p[1] === col);
    if (!pv) return [{ s: nm }];
    const row = sol.R[pv[0]];
    let items = [];
    const cst = round14(row[n]);
    for (let j = 0; j < n; j++) {
      if (j === col || pivotCols.includes(j)) continue;
      const k = -round14(row[j]);
      if (Math.abs(k) < 1e-12) continue;
      const mag = Math.abs(k) === 1 ? [] : numItemsExact(Math.abs(k), st);
      items = items.concat(k < 0 ? [{ s: '-' }] : items.length ? [{ s: '+' }] : [], mag, [{ s: names[j] }]);
    }
    if (cst !== 0 || !items.length) {
      items = items.concat(cst < 0 ? [{ s: '-' }] : items.length ? [{ s: '+' }] : [], numItemsExact(Math.abs(cst), st));
    }
    if (items.length && items[0].s === '-') items[0] = { s: 'neg' };
    return items;
  });
}

// Numeric solver for one variable of an equation (lhs - rhs = 0).
function numSolve(lhs, rhs, v, guess, state) {
  const ctx = makeCtx(state);
  const L = parseItems(lhs, ctx), R = parseItems(rhs, ctx);
  const F = x => {
    const l = evalWith(L, { [v]: cx(x) }, ctx), r = evalWith(R, { [v]: cx(x) }, ctx);
    return rnum(l) - rnum(r);
  };
  const safe = x => { try { const y = F(x); return isFinite(y) ? y : NaN; } catch (e) { return NaN; } };
  let x = guess;
  // Newton / secant first
  for (let it = 0; it < 60; it++) {
    const y = safe(x);
    if (isNaN(y)) break;
    if (y === 0) return finishSolve(x, F);
    const h = 1e-6 * Math.max(1, Math.abs(x));
    const d = (safe(x + h) - safe(x - h)) / (2 * h);
    if (!isFinite(d) || d === 0) break;
    const nx = x - y / d;
    if (!isFinite(nx)) break;
    if (Math.abs(nx - x) <= 1e-14 * Math.max(1, Math.abs(x))) {
      if (Math.abs(safe(nx)) < 1e-9 * Math.max(1, Math.abs(nx))) return finishSolve(nx, F);
      break;
    }
    x = nx;
  }
  // search for a sign change around the guess
  const y0 = safe(guess);
  let a = null, b = null;
  let step = 0.1 * Math.max(1, Math.abs(guess));
  for (let k = 0; k < 400 && a === null; k++) {
    for (const dir of [1, -1]) {
      const p = guess + dir * step, q = guess + dir * step / 1.5;
      const yp = safe(p), yq = safe(q);
      if (!isNaN(yp) && !isNaN(yq) && Math.sign(yp) !== Math.sign(yq)) { a = q; b = p; break; }
      if (!isNaN(y0) && !isNaN(yp) && Math.sign(yp) !== Math.sign(y0)) { a = guess; b = p; break; }
    }
    step *= 1.5;
    if (step > 1e99) break;
  }
  if (a === null) err('No sign change Change guess');
  let fa = safe(a);
  for (let it = 0; it < 300; it++) {
    const m = (a + b) / 2, fm = safe(m);
    if (fm === 0 || Math.abs(b - a) <= 1e-15 * Math.max(1, Math.abs(m))) return finishSolve(m, F);
    if (Math.sign(fm) === Math.sign(fa)) { a = m; fa = fm; } else b = m;
  }
  err('Max Iterations Change guess');
}
function finishSolve(x, F) {
  x = round14(x);
  if (Math.abs(x - Math.round(x)) < 1e-11 * Math.max(1, Math.abs(x))) {
    try { if (Math.abs(F(Math.round(x))) <= Math.abs(F(x))) x = Math.round(x); } catch (e) { /* keep x */ }
  }
  return { x, diff: round14(F(x)) };
}

// ---------------------------------------------------------------- formatting
function strItems(str) {
  const out = [];
  for (const ch of str) {
    if (ch === '-') out.push({ s: 'neg' });
    else if (/[A-F]/.test(ch)) out.push({ s: 'h' + ch });
    else out.push({ s: ch });
  }
  return out;
}
const intItems = n => strItems(String(n));

function fmtReal(x, st) {
  if (x === 0) return { neg: false, m: st.fix != null && st.notation === 'NORM' ? (0).toFixed(st.fix) : '0', e: null };
  const neg = x < 0, a = Math.abs(x);
  let notation = st.notation;
  if (notation === 'NORM') {
    if (st.fix != null) {
      if (a < 1e10) {
        const s = a.toFixed(st.fix);
        if (parseFloat(s) < 1e10) return { neg: neg && parseFloat(s) !== 0, m: s, e: null };
      }
      notation = 'SCI';
    } else if (a >= 1e10 || a < 1e-3) {
      notation = 'SCI';
    } else {
      let s = a.toPrecision(10);
      if (s.includes('e')) s = Number(s).toString();
      if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
      if (parseFloat(s) >= 1e10) notation = 'SCI';
      else return { neg, m: s, e: null };
    }
  }
  const digits = st.fix != null ? st.fix : 9;
  let [m, e] = a.toExponential(digits).split('e');
  e = parseInt(e, 10);
  if (notation === 'ENG') {
    const e3 = Math.floor(e / 3) * 3;
    const dec = st.fix != null ? st.fix : Math.max(0, 9 - (e - e3));
    let mv = a / Math.pow(10, e3);
    let ms = mv.toFixed(dec);
    if (parseFloat(ms) >= 1000) {
      const e3b = e3 + 3;
      ms = (a / Math.pow(10, e3b)).toFixed(st.fix != null ? st.fix : 9);
      e = e3b;
    } else e = e3;
    m = ms;
  }
  if (st.fix == null && m.includes('.')) m = m.replace(/0+$/, '').replace(/\.$/, '');
  return { neg, m, e };
}

function decItems(x, st) {
  const f = fmtReal(x, st);
  const out = [];
  if (f.neg) out.push({ s: 'neg' });
  out.push(...strItems(f.m));
  if (f.e !== null) {
    if (st.mathprint) out.push({ s: '*' }, { s: '1' }, { s: '0' }, { t: 'pow', a: [intItems(f.e)] });
    else out.push({ s: 'E' }, ...intItems(f.e));
  }
  return out;
}

function fracItems(n, d, st) {
  if (st.mathprint) return [{ t: 'frac', a: [n, d] }];
  return n.concat([{ s: 'cfrac' }], d);
}
function signed(neg, items) { return neg ? [{ s: 'neg' }].concat(items) : items; }

// Exact display for a real number (fraction, radical, or multiple of pi), else null.
function exactForm(x, st, allowInt) {
  if (!isFinite(x)) return null;
  const neg = x < 0, a = Math.abs(x);
  const r = rat(a, 10000);
  if (r) {
    if (r[1] === 1) return allowInt ? signed(neg, intItems(r[0])) : null;
    if (r[0] >= 1e10) return null;
    return signed(neg, fracItems(intItems(r[0]), intItems(r[1]), st));
  }
  const r2 = rat(a * a, 10000, 1e-11 * Math.max(1, a * a));
  if (r2 && r2[0] * r2[1] < 1e10) {
    const [s, rad] = sqfree(r2[0] * r2[1]);
    if (rad > 1 && rad < 10000) {
      let num = s, den = r2[1];
      const g = gcd(num, den); num /= g; den /= g;
      const core = radicalCore(num, rad, st);
      return signed(neg, den === 1 ? core : fracItems(core, intItems(den), st));
    }
  }
  const r3 = rat(a / PI, 1000);
  if (r3) {
    const core = (r3[0] === 1 ? [] : intItems(r3[0])).concat([{ s: 'pi' }]);
    return signed(neg, r3[1] === 1 ? core : fracItems(core, intItems(r3[1]), st));
  }
  return null;
}
function numItemsExact(x, st) { return exactForm(x, st, true) || decItems(x, st); }
function numItems(x, st, exact) {
  if (exact) { const e = exactForm(x, st, false); if (e) return e; }
  return decItems(x, st);
}

function complexItems(z, st, exact, polar) {
  if (polar) {
    const r = cAbs(z), t = fromRad(cArg(z), st.angle);
    return numItems(round14(r), st, exact).concat([{ s: 'angle' }], numItems(round14(t), st, exact && st.angle === 'RAD' || exact));
  }
  if (z.im === 0) return numItems(z.re, st, exact);
  const re = z.re === 0 ? [] : numItems(z.re, st, exact);
  const ia = Math.abs(z.im);
  let im = ia === 1 ? [] : numItems(ia, st, exact);
  const out = re.slice();
  if (z.im < 0) out.push(re.length ? { s: '-' } : { s: 'neg' }); else if (re.length) out.push({ s: '+' });
  return out.concat(im, [{ s: 'i' }]);
}

function dmsItems(x, st) {
  const neg = x < 0; let a = Math.abs(x);
  let d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf + 1e-9), s = round14((mf - m) * 60);
  if (s < 0) s = 0;
  if (s >= 60 - 1e-9) { s = 0; m++; }
  if (m >= 60) { m = 0; d++; }
  const sf = fmtReal(s, Object.assign({}, st, { notation: 'NORM' }));
  return signed(neg, intItems(d).concat([{ s: 'deg' }], intItems(m), [{ s: 'min' }], strItems(sf.m), [{ s: 'sec' }]));
}

function baseItems(n, base) {
  const bits = BASE_BITS[base], radix = BASE_RADIX[base];
  let u = BigInt.asUintN(bits, BigInt(Math.trunc(n)));
  return strItems(u.toString(radix).toUpperCase());
}

function pfactorItems(n, st) {
  if (!isInt(n) || n < 2) err('DOMAIN');
  n = Math.round(n);
  const fs = [];
  for (let p = 2; p * p <= n; p++) {
    let k = 0; while (n % p === 0) { n /= p; k++; }
    if (k) fs.push([p, k]);
  }
  if (n > 1) fs.push([n, 1]);
  let out = [];
  fs.forEach(([p, k], i) => {
    if (i) out.push({ s: '*' });
    out = out.concat(intItems(p));
    if (k > 1) out = out.concat(st.mathprint ? [{ t: 'pow', a: [intItems(k)] }] : [{ s: '^' }].concat(intItems(k)));
  });
  return out;
}

function mixedItems(x, st) {
  const r = rat(Math.abs(x), 10000);
  if (!r || r[1] === 1) return null;
  const neg = x < 0, w = Math.floor(r[0] / r[1]), n = r[0] - w * r[1];
  if (w === 0) return signed(neg, fracItems(intItems(n), intItems(r[1]), st));
  if (st.mathprint) return signed(neg, [{ t: 'mixed', a: [intItems(w), intItems(n), intItems(r[1])] }]);
  return signed(neg, intItems(w).concat([{ s: 'cmix' }], intItems(n), [{ s: 'cfrac' }], intItems(r[1])));
}

// Build display items for an evaluation result. alt toggles exact/decimal.
function resultItems(res, st, alt) {
  const v = res.value;
  if (v instanceof Mat) return [{ t: 'mat', r: v.r, c: v.c, a: v.rows.flat().map(x => numItems(x, st, !res.approx)) }];
  if (v instanceof Vec) return [{ t: 'mat', r: 1, c: v.a.length, vec: true, a: v.a.map(x => numItems(x, st, !res.approx)) }];
  if (v instanceof List) return [{ t: 'list', a: v.a.map(x => numItems(x, st, !res.approx)) }];
  const dir = res.directive;
  if (st.base !== 'DEC' && !dir) return baseItems(v.re, st.base);
  switch (dir) {
    case 'toHex': return baseItems(rnum(v), 'HEX').concat(st.base === 'HEX' ? [] : [{ s: 'sh' }]);
    case 'toBin': return baseItems(rnum(v), 'BIN').concat(st.base === 'BIN' ? [] : [{ s: 'sb' }]);
    case 'toOct': return baseItems(rnum(v), 'OCT').concat(st.base === 'OCT' ? [] : [{ s: 'so' }]);
    case 'toDec': return decItems(Math.trunc(rnum(v)), st);
    case 'toDMS': return alt ? decItems(rnum(v), st) : dmsItems(rnum(v), st);
    case 'toPf': return alt ? decItems(rnum(v), st) : pfactorItems(rnum(v), st);
    case 'toFrac': {
      const x = rnum(v);
      if (alt) return decItems(x, st);
      return mixedItems(x, st) || numItems(x, st, true);
    }
    case 'toFD': {
      const x = rnum(v);
      const ex = exactForm(x, st, false);
      // Converts a decimal to a fraction, or a fraction to a decimal.
      const wantExact = res.approx ? !alt : !!alt;
      return wantExact && ex ? ex : decItems(x, st);
    }
    case 'toPolar': if (v.im === 0) err('DATA TYPE'); return complexItems(v, st, !res.approx !== !!alt, true);
    case 'toRect': if (v.im === 0) err('DATA TYPE'); return complexItems(v, st, !res.approx !== !!alt, false);
  }
  const exact = alt ? res.approx : !res.approx;
  if (v.im !== 0) return complexItems(v, st, exact, st.cplx === 'POLAR');
  return numItems(v.re, st, exact);
}

// Plain-text value for menus and short displays.
function valueText(v, st, exact) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') v = cx(v);
  return itemsText(isCx(v) ? (v.im === 0 ? numItems(v.re, st, exact) : complexItems(v, st, exact, st.cplx === 'POLAR')) : []);
}
function itemsText(items) {
  return items.map(it => {
    if (!it.t) { const s = SYM[it.s]; return s ? (s.id === 'neg' ? '-' : s.d) : '?'; }
    if (it.t === 'frac') return itemsText(it.a[0]) + '/' + itemsText(it.a[1]);
    if (it.t === 'pow') return '^' + itemsText(it.a[0]);
    if (it.t === 'sqrt') return '√' + itemsText(it.a[0]);
    return '…';
  }).join('');
}

// ---------------------------------------------------------------- exports
TI.engine = {
  CalcError, err, SYM, TPL, CONSTANTS, CONVERSIONS, STATVARS, Cx, cx, Mat, Vec, List, isCx,
  defaultSettings, BASE_BITS, evaluate, parseItems, makeCtx, evalWith, rnum, round14, rat,
  oneVar, twoVar, regression, regEqItems, normalPdf, normalCdf, invNorm, binomPdf, binomCdf, poissonPdf, poissonCdf,
  quadSolve, cubicSolve, linSystem, linInfiniteItems, numSolve,
  resultItems, numItems, numItemsExact, decItems, exactForm, complexItems, strItems, intItems, valueText, itemsText,
  fmtReal, scanComplex, lex,
};
})(calculatorScope);

// Upstream source: editor.js
/* Entry editor: a row of symbols and MathPrint templates with a cursor.
   The cursor is a path of [itemIndex, slotIndex] pairs from the root row plus a position. */
(function (G) {
'use strict';
const TI = G.TI || (G.TI = {});
const { SYM } = TI.engine;

const MAX_DEPTH = 4;           // TI allows four levels of nested MathPrint templates
const MAX_ITEMS = 88;

// Slot that the cursor enters first, and up/down moves inside each template.
const NAV = {
  frac: { first: 0, up: { 1: 0 }, down: { 0: 1 } },
  mixed: { first: 0, up: { 2: 1 }, down: { 1: 2 } },
  pow: { first: 0 }, sqrt: { first: 0 }, root: { first: 0 }, exp_e: { first: 0 }, exp_10: { first: 0 }, abs: { first: 0 },
  deriv: { first: 0 },
  integ: { first: 0, up: { 0: 1 }, down: { 1: 0 } },
  sum: { first: 0, up: { 0: 1 }, down: { 1: 0 } },
  prod: { first: 0, up: { 0: 1 }, down: { 1: 0 } },
};

const clone = x => JSON.parse(JSON.stringify(x));
const isNumSym = it => it && !it.t && SYM[it.s] && SYM[it.s].k === 'dig';

class Editor {
  constructor(opts) {
    opts = opts || {};
    this.root = opts.items ? clone(opts.items) : [];
    this.path = [];
    this.i = this.root.length;
    this.insertMode = false;
    this.maxItems = opts.maxItems || MAX_ITEMS;
    this.allowTemplates = opts.allowTemplates !== false;
  }
  rowAt(path) {
    let r = this.root;
    for (const [ii, si] of path) r = r[ii].a[si];
    return r;
  }
  get row() { return this.rowAt(this.path); }
  get parent() { // template containing the cursor
    if (!this.path.length) return null;
    const p = this.path[this.path.length - 1];
    const pr = this.rowAt(this.path.slice(0, -1));
    return { node: pr[p[0]], ii: p[0], si: p[1], row: pr };
  }
  isEmpty() { return this.root.length === 0; }
  atRootStart() { return !this.path.length && this.i === 0; }
  clear() { this.root = []; this.path = []; this.i = 0; this.insertMode = false; }
  set(items) { this.root = clone(items); this.path = []; this.i = this.root.length; this.insertMode = false; }
  items() { return this.root; }
  count(r) { return (r || this.root).reduce((n, it) => n + (it.t ? 1 + it.a.reduce((m, s) => m + this.count(s), 0) : 1), 0); }

  inVarSlot() {
    const p = this.parent;
    return !!p && isVarSlot(p.node, p.si);
  }
  insert(item) {
    if (this.count() >= this.maxItems) return false;
    const r = this.row;
    if (this.inVarSlot()) {
      // The variable slot of d/dx and ∫ holds exactly one variable.
      if (!item.t && SYM[item.s] && SYM[item.s].isVar) { r.splice(0, r.length, item); this.i = 1; }
      return true;
    }
    if (!this.insertMode && this.i < r.length && !r[this.i].t && !item.t) {
      r[this.i] = item;
    } else {
      r.splice(this.i, 0, item);
    }
    this.i++;
    return true;
  }
  insertMany(items) {
    for (const it of clone(items)) {
      if (it.t) { this.row.splice(this.i, 0, it); this.i++; } else this.insert(it);
    }
  }

  // Insert a template. With grab, a number just left of the cursor becomes the first slot.
  template(type, opts) {
    opts = opts || {};
    if (!this.allowTemplates) return false;
    if (this.path.length >= MAX_DEPTH) throw new TI.engine.CalcError('TOO COMPLEX');
    const slots = { frac: 2, mixed: 3, pow: 1, sqrt: 1, root: 2, exp_e: 1, exp_10: 1, abs: 1, deriv: 3, integ: 4, sum: 3, prod: 3 }[type];
    const node = { t: type, a: Array.from({ length: slots }, () => []) };
    if (type === 'deriv') node.a[1] = [{ s: 'x' }];
    if (type === 'integ') node.a[3] = [{ s: 'x' }];
    if (opts.fill) opts.fill.forEach((f, k) => { node.a[k] = clone(f); });
    let enter = NAV[type].first;
    const r = this.row;
    if (opts.grab) {
      let j = this.i;
      while (j > 0 && isNumSym(r[j - 1])) j--;
      if (j < this.i) {
        node.a[0] = r.splice(j, this.i - j);
        this.i = j;
        enter = 1;
      } else if (opts.grabAny && this.i > 0 && (r[this.i - 1].t || ['pi', 'e', 'ans', 'x', 'y', 'z', 't', 'a', 'b', 'c', 'd'].includes(r[this.i - 1].s))) {
        node.a[0] = r.splice(this.i - 1, 1);
        this.i--;
        enter = 1;
      }
    }
    if (opts.enter != null) enter = opts.enter;
    r.splice(this.i, 0, node);
    this.path = this.path.concat([[this.i, enter]]);
    this.i = node.a[enter].length;
    return node;
  }

  // Change the type of the template containing the cursor (multi-tap e^□ ↔ 10^□).
  retypeParent(type) {
    const p = this.parent;
    if (p) p.node.t = type;
  }
  // Replace the symbol just left of the cursor (multi-tap keys).
  replacePrev(item) {
    const r = this.row;
    if (this.i > 0 && !r[this.i - 1].t) r[this.i - 1] = item;
  }
  prev() { const r = this.row; return this.i > 0 ? r[this.i - 1] : null; }

  left() {
    const r = this.row;
    if (this.i > 0) {
      const it = r[this.i - 1];
      if (it.t && it.a.length) {
        const order = slotOrder(it);
        const si = order[order.length - 1];
        this.path = this.path.concat([[this.i - 1, si]]);
        this.i = it.a[si].length;
      } else this.i--;
      return true;
    }
    const p = this.parent;
    if (!p) return false;
    const order = slotOrder(p.node), k = order.indexOf(p.si);
    if (isVarSlot(p.node, p.si) && this.i > 0) { this.i = 0; }
    if (k > 0) {
      this.path = this.path.slice(0, -1).concat([[p.ii, order[k - 1]]]);
      this.i = p.node.a[order[k - 1]].length;
    } else {
      this.path = this.path.slice(0, -1);
      this.i = p.ii;
    }
    return true;
  }
  right() {
    const r = this.row;
    if (this.i < r.length) {
      const it = r[this.i];
      if (it.t && it.a.length) {
        this.path = this.path.concat([[this.i, slotOrder(it)[0]]]);
        this.i = 0;
      } else this.i++;
      return true;
    }
    if (this.inVarSlot() && this.i < r.length) { this.i = r.length; return true; }
    const p = this.parent;
    if (!p) return false;
    const order = slotOrder(p.node), k = order.indexOf(p.si);
    if (k < order.length - 1) {
      const next = order[k + 1];
      this.path = this.path.slice(0, -1).concat([[p.ii, next]]);
      this.i = isVarSlot(p.node, next) ? p.node.a[next].length : 0;
    } else {
      this.path = this.path.slice(0, -1);
      this.i = p.ii + 1;
    }
    return true;
  }
  vertical(dir) {
    for (let d = this.path.length - 1; d >= 0; d--) {
      const sub = this.path.slice(0, d + 1);
      const [ii, si] = sub[d];
      const node = this.rowAt(sub.slice(0, -1))[ii];
      const nav = NAV[node.t] && NAV[node.t][dir];
      if (nav && nav[si] != null) {
        this.path = sub.slice(0, -1).concat([[ii, nav[si]]]);
        this.i = Math.min(this.i, node.a[nav[si]].length);
        if (d < this.path.length - 1) this.i = node.a[nav[si]].length;
        return true;
      }
    }
    return false;
  }
  up() { return this.vertical('up'); }
  down() { return this.vertical('down'); }
  home() { this.path = []; this.i = 0; }
  end() { this.path = []; this.i = this.root.length; }

  del() {
    const r = this.row;
    if (this.i < r.length) { r.splice(this.i, 1); return true; }
    if (this.i > 0) { r.splice(this.i - 1, 1); this.i--; return true; }
    const p = this.parent;
    if (p && p.node.a.every(s => s.length === 0 || (s.length === 1 && s[0].s === 'x' && (p.node.t === 'deriv' || p.node.t === 'integ')))) {
      p.row.splice(p.ii, 1);
      this.path = this.path.slice(0, -1);
      this.i = p.ii;
      return true;
    }
    return false;
  }
  // Variables used in the entry, in calculator order.
  vars() {
    const found = new Set();
    const walk = r => r.forEach(it => { if (it.t) it.a.forEach(walk); else if (SYM[it.s] && SYM[it.s].isVar) found.add(it.s); });
    walk(this.root);
    return 'xyztabcd'.split('').filter(v => found.has(v));
  }
}

function isVarSlot(node, si) {
  return (node.t === 'deriv' && si === 1) || (node.t === 'integ' && si === 3);
}
function slotOrder(node) {
  return node.a.map((_, k) => k);
}

TI.Editor = Editor;
TI.editorClone = clone;
})(calculatorScope);

// Upstream source: render.js
/* Renders entry rows and result items to HTML, in MathPrint (textbook) or Classic (one line) style. */
(function (G) {
'use strict';
const TI = G.TI || (G.TI = {});
const { SYM } = TI.engine;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A stretchy radical keeps the hook and overbar clear for tall MathPrint slots.
// Screen PNG export uses these same points instead of relying on a font glyph.
const radicalPoints = [[2, 62], [23, 54], [43, 96], [92, 0], [100, 0]];
function radicalHtml(radicand) {
  const path = radicalPoints.map(([x, y], i) => (i ? 'L' : 'M') + x + ' ' + y).join(' ');
  return '<span class="sqrt"><span class="rs" role="img" aria-label="root"><span hidden>√</span>' +
    '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="' + path +
    '" vector-effect="non-scaling-stroke" stroke-linecap="square" stroke-linejoin="miter"/></svg></span>' +
    '<span class="under"><span class="root-overbar" aria-hidden="true"></span>' + radicand + '</span></span>';
}
const classicRadical = '<span class="classic-root">√</span>';

function symHtml(id) {
  const s = SYM[id];
  if (!s) return '?';
  if (s.h) return s.h;
  if (id === 'csqrt(') return classicRadical + '(';
  if (id === 'xroot') return 'ˣ' + classicRadical;
  if (id === 'neg') return '<span class="ng">-</span>';
  if (id === 'cfrac') return '<span class="cf">⁄</span>';
  if (id === 'cmix') return '<span class="cm">⌟</span>';
  if (s.k === 'bin' && /^[+−×÷∠]$/.test(s.d)) return '<span class="op">' + s.d + '</span>';
  return esc(s.d);
}

// opts: { mp: MathPrint?, cur: {path, i, ins} | null, blink }
function renderItems(items, opts) {
  return rowHtml(items, [], opts);
}

function samePath(a, b) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k][0] !== b[k][0] || a[k][1] !== b[k][1]) return false;
  return true;
}

function rowHtml(items, path, opts, cls) {
  const cur = opts.cur && samePath(opts.cur.path, path) ? opts.cur : null;
  let h = '';
  if (!items.length) {
    if (!path.length) return '<span class="row' + (cls ? ' ' + cls : '') + '">' + (cur ? '<span class="cur-end"></span>' : '') + '</span>';
    return '<span class="row empty' + (cls ? ' ' + cls : '') + '"><span class="ph' + (cur ? ' cur' : '') + '"></span></span>';
  }
  items.forEach((it, k) => {
    if (cur && cur.i === k && (cur.ins || it.t)) h += '<span class="cur-ins"></span>';
    const onIt = cur && cur.i === k && !cur.ins && !it.t;
    if (it.t) h += tplHtml(it, path.concat([[k, -1]]), opts);
    else h += '<span class="sy' + (onIt ? ' cur' : '') + '">' + symHtml(it.s) + '</span>';
  });
  if (cur && cur.i === items.length) h += '<span class="cur-end"></span>';
  return '<span class="row' + (cls ? ' ' + cls : '') + '">' + h + '</span>';
}

function slot(node, k, base, opts, cls) {
  const p = base.slice(0, -1).concat([[base[base.length - 1][0], k]]);
  return rowHtml(node.a[k], p, opts, cls);
}

function plainText(items) {
  return items.map(it => (it.t ? '' : (SYM[it.s] ? SYM[it.s].d : ''))).join('');
}

function tplHtml(node, base, opts) {
  const S = (k, cls) => slot(node, k, base, opts, cls);
  if (node.t === 'mat') return matHtml(node, base, opts);
  if (node.t === 'list') return '<span class="lst">{' + node.a.map((_, k) => S(k)).join('<span class="lsep"> </span>') + '}</span>';
  if (!opts.mp) return classicTpl(node, S);
  switch (node.t) {
    case 'frac': return '<span class="frac"><span class="num">' + S(0) + '</span><span class="den">' + S(1) + '</span></span>';
    case 'mixed': return '<span class="mixed">' + S(0) + '<span class="frac"><span class="num">' + S(1) + '</span><span class="den">' + S(2) + '</span></span></span>';
    case 'pow': return '<span class="sup">' + S(0) + '</span>';
    case 'sqrt': return radicalHtml(S(0));
    case 'root': return '<span class="root"><span class="idx">' + S(0) + '</span>' + radicalHtml(S(1)) + '</span>';
    case 'exp_e': return '<span class="sy"><i class="ke">e</i></span><span class="sup">' + S(0) + '</span>';
    case 'exp_10': return '<span class="sy">10</span><span class="sup">' + S(0) + '</span>';
    case 'abs': return '<span class="abs">' + S(0) + '</span>';
    case 'deriv': {
      const v = esc(plainText(node.a[1]) || '□');
      return '<span class="frac dd"><span class="num">d</span><span class="den">d<i>' + v + '</i></span></span>(' + S(0) + ')<span class="bar"></span><span class="at">' + S(1) + '=' + S(2) + '</span>';
    }
    case 'integ':
      return '<span class="bigop"><span class="hi">' + S(1) + '</span><span class="sym int">∫</span><span class="lo">' + S(0) + '</span></span>' + S(2) + '<span class="sy">d</span>' + S(3);
    case 'sum': case 'prod':
      return '<span class="bigop"><span class="hi">' + S(1) + '</span><span class="sym">' + (node.t === 'sum' ? 'Σ' : 'Π') + '</span><span class="lo"><i>x</i>=' + S(0) + '</span></span>(' + S(2) + ')';
  }
  return '';
}

function classicTpl(node, S) {
  switch (node.t) {
    case 'frac': return S(0) + '<span class="cf">⁄</span>' + S(1);
    case 'mixed': return S(0) + '<span class="cm">⌟</span>' + S(1) + '<span class="cf">⁄</span>' + S(2);
    case 'pow': return '^(' + S(0) + ')';
    case 'sqrt': return classicRadical + '(' + S(0) + ')';
    case 'root': return S(0) + 'ˣ' + classicRadical + '(' + S(1) + ')';
    case 'exp_e': return '<i class="ke">e</i>^(' + S(0) + ')';
    case 'exp_10': return '10^(' + S(0) + ')';
    case 'abs': return 'abs(' + S(0) + ')';
    case 'deriv': return 'nDeriv(' + S(0) + ',' + S(1) + ',' + S(2) + ')';
    case 'integ': return 'fnInt(' + S(2) + ',' + S(3) + ',' + S(0) + ',' + S(1) + ')';
    case 'sum': return 'sum(' + S(2) + ',' + S(0) + ',' + S(1) + ')';
    case 'prod': return 'prod(' + S(2) + ',' + S(0) + ',' + S(1) + ')';
  }
  return '';
}

function matHtml(node, base, opts) {
  let h = '<span class="mat"><span class="mb l"></span><span class="mg" style="grid-template-columns:repeat(' + node.c + ',auto)">';
  node.a.forEach((_, k) => { h += '<span class="mc">' + slot(node, k, base, opts) + '</span>'; });
  return h + '</span><span class="mb r"></span></span>';
}

TI.render = { renderItems, symHtml, esc, radicalHtml, radicalPoints };
})(calculatorScope);

// Upstream source: state.js
/* Saved calculator state: legacy serialization with independent field recovery. */
(function (G) {
'use strict';
const TI = G.TI, E = TI.engine;
const STORE_KEY = 'patterdraw-ti36x-v1';
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const finite = x => typeof x === 'number' && Number.isFinite(x);
const integer = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function freshState() {
  return {
    settings: E.defaultSettings(), vars: {}, varApprox: {}, ans: E.cx(0), ansApprox: false,
    lists: { L1: [], L2: [], L3: [] }, formulas: { L1: null, L2: null, L3: null },
    mats: {}, vecs: {}, ansMat: null, stat: null, fx: null, op: null,
    table: { start: 0, step: 1, auto: true, askX: [] },
    rng: { seed: Date.now() >>> 0 }, history: [],
    numsolv: { lhs: [], rhs: [] }, exprEval: [], sys: { 2: null, 3: null }, statCfg: { x: 0, y: 1, f: 0 },
    contrast: 0,
  };
}

function packVal(v) {
  if (v instanceof E.Cx) return { _: 'c', re: v.re, im: v.im };
  if (v instanceof E.Mat) return { _: 'm', rows: v.rows };
  if (v instanceof E.Vec) return { _: 'v', a: v.a };
  return null;
}
function matrix(rows, r, c) {
  return Array.isArray(rows) && (r == null ? integer(rows.length, 1, 3) : rows.length === r) &&
    rows.every(row => Array.isArray(row) && (c == null ? integer(row.length, 1, 3) && row.length === rows[0].length : row.length === c) && row.every(finite));
}
function unpackVal(o) {
  if (!record(o)) return null;
  if (o._ === 'c' && finite(o.re) && finite(o.im)) return E.cx(o.re, o.im);
  if (o._ === 'm' && matrix(o.rows)) return new E.Mat(o.rows);
  if (o._ === 'v' && Array.isArray(o.a) && integer(o.a.length, 2, 3) && o.a.every(finite)) return new E.Vec(o.a);
  return null;
}

// Accept incomplete editor expressions as well as generated result templates.
// Limits exceed the editor's four nesting levels to allow formatted results.
function items(row) {
  let remaining = 4096;
  function valid(r, depth) {
    if (!Array.isArray(r) || r.length > 2048 || depth > 16) return false;
    return r.every(it => {
      if (--remaining < 0 || !record(it)) return false;
      if (!own(it, 't')) return typeof it.s === 'string' && own(E.SYM, it.s);
      if (typeof it.t !== 'string' || !own(E.TPL, it.t) || !Array.isArray(it.a)) return false;
      const n = E.TPL[it.t].n;
      if (n >= 0 && it.a.length !== n) return false;
      if (it.t === 'mat' && (!integer(it.r, 1, 3) || !integer(it.c, 1, 3) || it.a.length !== it.r * it.c ||
          (own(it, 'vec') && (typeof it.vec !== 'boolean' || (it.vec && (it.r !== 1 || it.c < 2)))))) return false;
      if (it.t === 'list' && it.a.length > 42) return false;
      return it.a.every(slot => valid(slot, depth + 1));
    });
  }
  return valid(row, 0);
}
function list(a) {
  // Empty list/table cells are serialized as null by the existing grid editor.
  return Array.isArray(a) && a.length <= 42 && a.every(x => x === null || finite(x));
}
function stat(o) {
  if (!record(o) || !record(o.vars)) return null;
  const vars = {};
  for (const k of Object.keys(E.STATVARS)) {
    if (finite(o.vars[k]) || o.vars[k] === 'Error') vars[k] = o.vars[k];
    else if (own(o.vars, k)) vars[k] = 'Error';
  }
  if (!Object.keys(vars).length) return null;
  const lin = o.lin === true;
  const validId = k => typeof k === 'string' && (own(vars, k) || (lin && (k === 'S_xp(' || k === 'S_yp(')));
  const order = Array.isArray(o.order) ? o.order.filter(validId) : Object.keys(vars);
  return { vars, order, title: typeof o.title === 'string' ? o.title.slice(0, 300) : 'StatVars',
    desc: typeof o.desc === 'string' ? o.desc.slice(0, 300) : undefined, lin };
}
function saveState(s) {
  try {
    const o = Object.assign({}, s);
    o.vars = {}; Object.keys(s.vars).forEach(k => { o.vars[k] = packVal(s.vars[k]); });
    o.ans = packVal(s.ans); o.ansMat = packVal(s.ansMat);
    o.mats = {}; Object.keys(s.mats).forEach(k => { o.mats[k] = packVal(s.mats[k]); });
    o.vecs = {}; Object.keys(s.vecs).forEach(k => { o.vecs[k] = packVal(s.vecs[k]); });
    G.localStorage.setItem(STORE_KEY, JSON.stringify(o));
  } catch (e) { /* storage unavailable: memory lasts for this visit only */ }
}
function loadState() {
  try {
    const raw = G.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!record(o)) return null;
    const s = freshState();
    const settings = record(o.settings) ? o.settings : {};
    for (const [k, values] of Object.entries({ angle: ['DEG', 'RAD', 'GRAD'], notation: ['NORM', 'SCI', 'ENG'], cplx: ['REAL', 'RECT', 'POLAR'], base: ['DEC', 'HEX', 'OCT', 'BIN'] })) {
      if (values.includes(settings[k])) s.settings[k] = settings[k];
    }
    if (settings.fix === null || integer(settings.fix, 0, 9)) s.settings.fix = settings.fix;
    if (typeof settings.mathprint === 'boolean') s.settings.mathprint = settings.mathprint;
    for (const k of 'xyztabcd') {
      const v = record(o.vars) ? unpackVal(o.vars[k]) : null;
      if (v instanceof E.Cx) s.vars[k] = v;
      if (record(o.varApprox) && typeof o.varApprox[k] === 'boolean') s.varApprox[k] = o.varApprox[k];
    }
    const ans = unpackVal(o.ans), ansMat = unpackVal(o.ansMat);
    if (ans instanceof E.Cx) s.ans = ans;
    if (ansMat instanceof E.Mat || ansMat instanceof E.Vec) s.ansMat = ansMat;
    if (typeof o.ansApprox === 'boolean') s.ansApprox = o.ansApprox;
    for (const [field, names, type] of [['mats', ['A', 'B', 'C'], E.Mat], ['vecs', ['u', 'v', 'w'], E.Vec]]) {
      if (record(o[field])) for (const k of names) { const v = unpackVal(o[field][k]); if (v instanceof type) s[field][k] = v; }
    }
    for (const k of ['L1', 'L2', 'L3']) {
      if (record(o.lists) && list(o.lists[k])) s.lists[k] = o.lists[k];
      if (record(o.formulas) && items(o.formulas[k])) s.formulas[k] = o.formulas[k];
    }
    for (const k of ['fx', 'op', 'exprEval']) if (items(o[k])) s[k] = o[k];
    if (record(o.numsolv)) for (const k of ['lhs', 'rhs']) if (items(o.numsolv[k])) s.numsolv[k] = o.numsolv[k];
    if (record(o.sys)) for (const n of [2, 3]) if (matrix(o.sys[n], n, n + 1)) s.sys[n] = o.sys[n];
    if (record(o.table)) {
      if (finite(o.table.start)) s.table.start = o.table.start;
      if (finite(o.table.step) && o.table.step !== 0) s.table.step = o.table.step;
      if (typeof o.table.auto === 'boolean') s.table.auto = o.table.auto;
      if (list(o.table.askX)) s.table.askX = o.table.askX;
    }
    if (record(o.statCfg)) for (const k of ['x', 'y', 'f']) if (integer(o.statCfg[k], 0, k === 'f' ? 3 : 2)) s.statCfg[k] = o.statCfg[k];
    if (record(o.rng) && integer(o.rng.seed, 0, 0xffffffff)) s.rng.seed = o.rng.seed;
    if (integer(o.contrast, -4, 4)) s.contrast = o.contrast;
    s.stat = stat(o.stat);
    if (Array.isArray(o.history)) s.history = o.history.filter(h => record(h) && items(h.entry)).slice(-30).map(h => ({
      entry: h.entry, res: items(h.res) ? h.res : null, altItems: items(h.altItems) ? h.altItems : null,
      alt: h.alt === true && items(h.altItems), opN: integer(h.opN, 0, Number.MAX_SAFE_INTEGER) ? h.opN : 0,
      ...(h.toggled === true && items(h.res) && items(h.altItems) ? { toggled: true } : {}),
    }));
    return s;
  } catch (e) { return null; }
}
TI.state = { freshState, saveState, loadState };
})(calculatorScope);

// Upstream source: math-drill.js
/* Whole-number arithmetic practice, independent of calculator memory and RNG. */
(function (G) {
'use strict';
const TI = G.TI = G.TI || {};
const OPERATIONS = Object.freeze([
  Object.freeze({ id: 'add', label: 'Addition', short: 'ADD', symbol: '+' }),
  Object.freeze({ id: 'sub', label: 'Subtraction', short: 'SUB', symbol: '−' }),
  Object.freeze({ id: 'mul', label: 'Multiplication', short: 'MUL', symbol: '×' }),
  Object.freeze({ id: 'div', label: 'Division', short: 'DIV', symbol: '÷' }),
]);
const MODES = Object.freeze([...OPERATIONS, Object.freeze({ id: 'mixed', label: 'Mixed practice', short: 'MIX' })]);
function makeQuestion(operation, random = Math.random) {
  const definition = OPERATIONS.find(o => o.id === operation);
  if (!definition) throw new TypeError('Unknown drill operation');
  const integer = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  let a, b, answer;
  if (operation === 'add') { a = integer(0, 20); b = integer(0, 20); answer = a + b; }
  if (operation === 'sub') {
    const x = integer(0, 20), y = integer(0, 20);
    a = Math.max(x, y); b = Math.min(x, y); answer = a - b;
  }
  if (operation === 'mul') { a = integer(0, 12); b = integer(0, 12); answer = a * b; }
  if (operation === 'div') { b = integer(1, 12); answer = integer(0, 12); a = b * answer; }
  return { operation, a, b, answer, symbol: definition.symbol };
}
class Session {
  constructor(mode, random = Math.random) {
    const definition = MODES.find(o => o.id === mode);
    if (!definition) throw new TypeError('Unknown drill mode');
    this.mode = mode; this.label = definition.label; this.short = definition.short; this.random = random;
    this.answered = 0; this.firstCorrect = 0; this.index = 0;
    this.next();
  }
  next() {
    const operation = this.mode === 'mixed' ? OPERATIONS[this.index % OPERATIONS.length].id : this.mode;
    this.question = makeQuestion(operation, this.random); this.index++;
    this.scored = false; this.solved = false;
  }
  submit(text) {
    if (this.solved) return 'solved';
    const input = String(text).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(input) || !Number.isFinite(Number(input))) return 'invalid';
    const correct = Number(input) === this.question.answer;
    if (!this.scored) {
      this.answered++; this.scored = true;
      if (correct) this.firstCorrect++;
    }
    this.solved = correct;
    return correct ? 'correct' : 'wrong';
  }
}
TI.mathDrill = { OPERATIONS, MODES, makeQuestion, Session };
})(calculatorScope);

// Upstream source: app.js
/* Calculator application: screens, menus, key handling, persistence and the on-screen keypad. */
(function (G) {
'use strict';
const TI = G.TI;
const E = TI.engine, R = TI.render, Editor = TI.Editor, clone = TI.editorClone;
const { CalcError, cx, SYM } = E;

// Saved-state recovery preserves the legacy browser storage format.
const { freshState, saveState, loadState } = TI.state;

// ======================================================================= helpers
const esc = R.esc;
const numItems = x => {
  const text = String(x), scientific = text.match(/^(.+)[eE]([+-]?\d+)$/);
  return scientific ? E.strItems(scientific[1]).concat({ s: 'E' }, E.strItems(scientific[2].replace(/^\+/, ''))) : E.strItems(text);
};
function itemsHtml(app, items) { return R.renderItems(items || [], { mp: app.state.settings.mathprint, cur: null }); }
function edHtml(app, ed, active) {
  return R.renderItems(ed.root, { mp: app.state.settings.mathprint, cur: active ? { path: ed.path, i: ed.i, ins: ed.insertMode } : null });
}
function contains(items, id) { return items.some(it => (it.t ? it.a.some(s => contains(s, id)) : it.s === id)); }

// Short number text for table and list cells.
function cellText(x) {
  if (x == null || x === '') return '';
  if (typeof x === 'string') return x;
  if (!isFinite(x)) return 'Error';
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(1).replace('e+', 'E').replace('e', 'E');
  let s = String(E.round14(x));
  if (s.length > 7) s = String(Number(x.toPrecision(6)));
  if (s.length > 7) s = String(Number(x.toPrecision(4)));
  return s.replace(/^-/, '-');
}
function valueHtml(app, v, exact) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') v = cx(v);
  const st = app.state.settings;
  const items = v.im !== 0 ? E.complexItems(v, st, exact, st.cplx === 'POLAR') : E.numItems(v.re, st, exact);
  return itemsHtml(app, items);
}
// Evaluate a field. Leading + or − are allowed as signs.
function evalField(app, items, opts) {
  items = items.slice();
  if (items.length && !items[0].t && items[0].s === '-') items[0] = { s: 'neg' };
  if (items.length && !items[0].t && items[0].s === '+') items.shift();
  if (!items.length) throw new CalcError('SYNTAX');
  const r = E.evaluate(items, app.state, opts);
  if (!E.isCx(r.value)) throw new CalcError('DATA TYPE');
  if (r.value.im !== 0 && !(opts && opts.complex)) throw new CalcError('Input must be Real');
  return r;
}
function fieldFor(value) {
  const ed = new Editor({ maxItems: 47 });
  if (value != null) ed.set(Array.isArray(value) ? value : numItems(E.round14(value)));
  return ed;
}

// ======================================================================= edit keys
const MULTI = {
  lnlog: () => [{ s: 'ln(' }, { s: 'log(' }],
  pi: () => [{ s: 'pi' }, { s: 'e' }, { s: 'i' }],
  sin: () => [{ s: 'sin(' }, { s: 'asin(' }, { s: 'sinh(' }, { s: 'asinh(' }],
  cos: () => [{ s: 'cos(' }, { s: 'acos(' }, { s: 'cosh(' }, { s: 'acosh(' }],
  tan: () => [{ s: 'tan(' }, { s: 'atan(' }, { s: 'tanh(' }, { s: 'atanh(' }],
  prb: () => [{ s: '!' }, { s: 'nCr' }, { s: 'nPr' }],
  var: () => 'xyztabcd'.split('').map(v => ({ s: v })),
  exp: mp => (mp ? [{ tpl: 'exp_e' }, { tpl: 'exp_10' }] : [{ s: 'cexp(' }, { s: 'c10(' }]),
};
const posKey = ed => JSON.stringify(ed.path) + ':' + ed.i;
const ANS_FIRST = new Set(['add', 'sub', 'mul', 'div', 'pow', 'sq', 'recip', 'percent', 'sto', 'fd', 'op', 'nroot']);

function editKey(app, ed, a, o) {
  o = o || {};
  const st = app.state.settings, mp = st.mathprint;
  const ins = s => ed.insert({ s });
  if (o.home && ed.isEmpty() && (ANS_FIRST.has(a) || (a === 'prb' && !(app.tap && app.tap.key === 'prb')))) ins('ans');
  if (MULTI[a]) {
    const list = MULTI[a](mp), tap = app.tap;
    if (tap && tap.key === a && tap.ed === ed && tap.pos === posKey(ed)) {
      tap.idx = (tap.idx + 1) % list.length;
      const nx = list[tap.idx];
      if (nx.tpl) ed.retypeParent(nx.tpl); else ed.replacePrev(nx);
      tap.pos = posKey(ed);
    } else {
      const first = list[0];
      if (first.tpl) ed.template(first.tpl); else ed.insert(first);
      app.tap = { key: a, ed, idx: 0, pos: posKey(ed) };
    }
    app.keepTap = true;
    return true;
  }
  const base = st.base;
  if (/^[0-9]$/.test(a)) {
    if (base === 'BIN' && a > '1') return true;
    if (base === 'OCT' && a > '7') return true;
    ins(a); return true;
  }
  switch (a) {
    case '.': if (base !== 'DEC') return true; ins('.'); return true;
    case 'hexA': case 'hexB': case 'hexC': case 'hexD': case 'hexE': case 'hexF': ins('h' + a[3]); return true;
    case 'add': ins('+'); return true;
    case 'sub': ins('-'); return true;
    case 'mul': ins('*'); return true;
    case 'div': ins('/'); return true;
    case 'neg': ins('neg'); return true;
    case 'lparen': ins('('); return true;
    case 'rparen': ins(')'); return true;
    case 'comma': ins(','); return true;
    case 'EE': if (base !== 'DEC') return true; ins('E'); return true;
    case 'percent': ins('%'); return true;
    case 'sq': ins('sq'); return true;
    case 'recip': ins('inv'); return true;
    case 'ans': ins('ans'); return true;
    case 'fd': ins('toFD'); return true;
    case 'op': ins('op'); return true;
    case 'sto': if (!o.home) return true; ins('sto'); return true;
    case 'pow': if (mp) ed.template('pow'); else ins('^'); return true;
    case 'sqrt': if (mp) ed.template('sqrt'); else ins('csqrt('); return true;
    case 'nroot': if (mp) ed.template('root', { grab: true }); else ins('xroot'); return true;
    case 'frac': if (mp) ed.template('frac', { grab: true, grabAny: true }); else ins('cfrac'); return true;
    case 'mixed': if (mp) ed.template('mixed', { grab: true }); else ins('cmix'); return true;
    case 'deriv': if (mp) ed.template('deriv'); else ins('nDeriv('); return true;
    case 'integ': if (mp) ed.template('integ'); else ins('fnInt('); return true;
    case 'left': ed.insertMode = false; ed.left(); return true;
    case 'right': ed.insertMode = false; ed.right(); return true;
    case 'lhome': ed.insertMode = false; ed.home(); return true;
    case 'lend': ed.insertMode = false; ed.end(); return true;
    case 'delete': ed.del(); return true;
    case 'insert': ed.insertMode = true; return true;
  }
  return false;
}

// Keys that leave or open screens; menus let these through.
const GLOBAL_KEYS = new Set(['quit', 'mode', 'reset', 'off', 'on', 'contrastUp', 'contrastDown', 'data', 'statreg', 'table',
  'expreval', 'numsolv', 'polysolv', 'syssolv', 'setop', 'matrix', 'vector', 'math', 'complex', 'constants', 'convert',
  'basen', 'random', 'recall', 'clearvar']);
const KEEP_KEYS = new Set(['left', 'right', 'lhome', 'lend', 'delete', 'insert', 'up', 'down', 'enter', 'clear', 'toggle', 'histUp', 'histDown']);
const FIELD_MODIFIERS = new Set([...ANS_FIRST, 'frac', 'mixed', 'prb', 'EE']);
const DEC_ONLY = new Set(['math', 'matrix', 'vector', 'data', 'statreg', 'table', 'expreval', 'numsolv', 'polysolv', 'syssolv',
  'complex', 'constants', 'convert', 'random', 'deriv', 'integ']);

// ======================================================================= screens
class Screen {
  constructor(app) { this.app = app; }
  get S() { return this.app.state; }
  editor() { return null; }
  key() { return false; }
  html() { return ''; }
}

class Home extends Screen {
  constructor(app) { super(app); this.ed = new Editor(); this.sel = null; this.cleared = app.state.history.length; }
  editor() { return this.sel == null ? this.ed : null; }
  key(a) {
    const H = this.S.history;
    if (this.sel != null) {
      if (a === 'up' || a === 'histUp') { this.moveSel(-1); return true; }
      if (a === 'down' || a === 'histDown') { this.moveSel(1); return true; }
      if (a === 'enter') {
        const h = H[this.sel.h];
        const items = this.sel.part === 'e' ? h.entry : (h.alt ? h.altItems : h.res);
        this.sel = null;
        if (items) this.ed.insertMany(items);
        return true;
      }
      if (a === 'clear') { this.sel = null; return true; }
      this.sel = null;
    }
    switch (a) {
      case 'enter': this.evaluate(); return true;
      case 'clear':
        if (!this.ed.isEmpty()) this.ed.clear(); else this.cleared = H.length;
        return true;
      case 'up':
        if (this.ed.up()) return true;
        if (H.length) this.startSel();
        return true;
      case 'histUp': if (H.length) this.startSel(); return true;
      case 'down': case 'histDown': this.ed.down(); return true;
      case 'toggle': {
        const h = H[H.length - 1];
        if (h && h.altItems) this.addHistory({
          entry: clone(h.entry), res: clone(h.res), altItems: clone(h.altItems),
          alt: !h.alt, opN: h.opN, toggled: true,
        });
        return true;
      }
    }
    return editKey(this.app, this.ed, a, { home: true });
  }
  startSel() {
    const H = this.S.history, last = H[H.length - 1];
    this.sel = { h: H.length - 1, part: last.res ? 'r' : 'e' };
    if (this.sel.h < this.cleared) this.cleared = this.sel.h;
  }
  moveSel(d) {
    const seq = [];
    this.S.history.forEach((h, k) => { seq.push({ h: k, part: 'e' }); if (h.res) seq.push({ h: k, part: 'r' }); });
    let idx = seq.findIndex(x => x.h === this.sel.h && x.part === this.sel.part) + d;
    if (idx < 0) idx = 0;
    if (idx >= seq.length) { this.sel = null; return; }
    this.sel = seq[idx];
    if (this.sel.h < this.cleared) this.cleared = this.sel.h;
  }
  addHistory(record) {
    const H = this.S.history;
    H.push(record);
    while (H.length > 30) { H.shift(); this.cleared = Math.max(0, this.cleared - 1); }
    this.app.save();
  }
  evaluate() {
    const H = this.S.history;
    let items = this.ed.items();
    if (!items.length) {
      if (!H.length) return;
      items = H[H.length - 1].entry;
    }
    let opN = 0;
    if (contains(items, 'op')) {
      const prev = H[H.length - 1];
      const repeat = items.length === 2 && items[0].s === 'ans' && items[1].s === 'op' && prev && prev.opN;
      opN = repeat ? prev.opN + 1 : 1;
    }
    const res = E.evaluate(items, this.S);
    const st = this.S.settings;
    const resItems = E.resultItems(res, st, false);
    let altItems = null;
    try {
      altItems = E.resultItems(res, st, true);
      if (JSON.stringify(altItems) === JSON.stringify(resItems)) altItems = null;
    } catch (e) { altItems = null; }
    if (res.value instanceof E.Mat || res.value instanceof E.Vec) this.S.ansMat = res.value;
    else if (E.isCx(res.value)) { this.S.ans = res.value; this.S.ansApprox = res.approx; }
    this.addHistory({ entry: clone(items), res: resItems, altItems, alt: false, opN });
    this.ed.clear();
  }
  html() {
    const app = this.app, H = this.S.history;
    let h = '';
    for (let k = this.cleared; k < H.length; k++) {
      const e = H[k];
      const selE = this.sel && this.sel.h === k && this.sel.part === 'e';
      const selR = this.sel && this.sel.h === k && this.sel.part === 'r';
      h += '<div class="history-line"><div class="ln le' + (selE ? ' sel' : '') + '">' + itemsHtml(app, e.entry) +
        (e.toggled ? '<span class="answer-toggle" aria-label="answer toggle">◂▸</span>' : '') + '</div>';
      if (e.res) {
        h += '<div class="ln lr' + (selR ? ' sel' : '') + '">' + (e.opN ? '<span class="opn">n=' + e.opN + '</span>' : '') +
          itemsHtml(app, e.alt ? e.altItems : e.res) + '</div>';
      }
      h += '</div>';
    }
    h += '<div class="ln le entry">' + edHtml(app, this.ed, this.sel == null) + '</div>';
    return '<div class="hist">' + h + '</div>';
  }
  scrollable() { return this.S.history.length > 0; }
}

class MsgScreen extends Screen {
  constructor(app, lines, onDone) { super(app); this.lines = lines; this.onDone = onDone; }
  key(a) {
    if (a === 'clear' || a === 'enter') { this.app.pop(); if (this.onDone) this.onDone(); return true; }
    return GLOBAL_KEYS.has(a) ? false : true;
  }
  html() { return '<div class="msg">' + this.lines.map(l => '<div class="ln">' + l + '</div>').join('') + '</div>'; }
}

const ERR_HINTS = {
  'SYNTAX': 'Check the entry for a misplaced operator, comma or parenthesis.',
  'DOMAIN': 'An argument is outside the allowed range.',
  'DIVIDE BY 0': 'Division by zero is undefined.',
  'OVERFLOW': 'The number is too large for the calculator.',
  'ARGUMENT': 'Wrong number of arguments.',
  'DATA TYPE': 'This value type is not allowed here.',
  'DIM MISMATCH': 'The dimensions do not match.',
  'SINGULAR MAT': 'This matrix has no inverse.',
  'STAT': 'Check the data lists.',
  'TOO COMPLEX': 'Too many nested MathPrint levels.',
  'INVALID FUNCTION': 'Define f(x) first: table, 2: Edit function.',
  'OP NOT DEFINED': 'Define an operation with 2nd [set op].',
  'FORMULA': 'Use another list and avoid circular dependencies.',
  'TOL NOT MET': 'The integral could not reach the required accuracy.',
  'FRQ DOMAIN': 'Use a non-negative frequency for each data value.',
  'INVALID EQUATION': 'Enter a valid expression on both sides of the equation.',
  'CHANGE MODE to DEC': 'Choose DEC in mode before using this function.',
  'Input must be Real': 'Enter a real value without an imaginary part.',
  'Input must be non-negative integer': 'Enter a whole number of zero or greater.',
  'Highest Degree coefficient cannot be zero': 'Use a nonzero coefficient for the highest power.',
  'Max Iterations Change guess': 'Try a guess closer to the expected solution.',
  'No sign change Change guess': 'Try a different guess or check that a real root exists.',
  '0<area<1': 'Enter an area strictly between zero and one.',
  'Mean mu>0': 'Enter a mean greater than zero.',
  'Number of trials 0<n<41': 'Use a whole number of trials from 1 to 40.',
  'Probability 0<p<1': 'Enter a probability strictly between zero and one.',
  'sigma>0 sigma Real': 'Use a positive real standard deviation.',
};
class ErrScreen extends Screen {
  constructor(app, type) { super(app); this.type = type; }
  key(a) {
    if (a === 'clear') { this.app.pop(); return true; }
    if (a === 'quit') return false;
    return true;
  }
  html() {
    const t = this.type, title = /^[A-Z0-9 ]+$/.test(t) && t.length < 16 ? t + ' ERROR' : t;
    return '<div class="err"><div class="ln et">' + esc(title) + '</div>' +
      (ERR_HINTS[t] ? '<div class="eh">' + esc(ERR_HINTS[t]) + '</div>' : '') +
      '<div class="ln ek">Press clear to go back</div></div>';
  }
}

// ---------------------------------------------------------------- menus
class MenuScreen extends Screen {
  constructor(app, tabs, onPick, opts) {
    super(app);
    opts = opts || {};
    this.tabs = tabs; this.onPick = onPick; this.t = opts.tab || 0; this.s = 0; this.top = 0; this.title = opts.title;
  }
  items() { return this.tabs[this.t].items; }
  key(a) {
    const items = this.items();
    if (GLOBAL_KEYS.has(a)) return false;
    if (a === 'up') { this.s = (this.s - 1 + items.length) % items.length; return true; }
    if (a === 'down') { this.s = (this.s + 1) % items.length; return true; }
    if (a === 'left' || a === 'right') {
      if (this.tabs.length > 1) { this.t = (this.t + (a === 'left' ? -1 : 1) + this.tabs.length) % this.tabs.length; this.s = 0; this.top = 0; }
      return true;
    }
    const d = '123456789'.indexOf(a);
    if (d >= 0) { if (d < items.length) { this.s = d; this.pick(); } return true; }
    if (a === 'enter') { this.pick(); return true; }
    if (a === 'clear') { this.app.pop(); return true; }
    return true;
  }
  pick() {
    const it = this.items()[this.s];
    this.app.pop();
    this.onPick(it, this);
  }
  html() {
    const items = this.items(), vis = 3;
    if (this.s < this.top) this.top = this.s;
    if (this.s >= this.top + vis) this.top = this.s - vis + 1;
    let h = '<div class="menu"><div class="ln tabs">';
    if (this.tabs.length > 1 || !this.title) {
      h += this.tabs.map((t, k) => '<span class="tab' + (k === this.t ? ' on' : '') + '">' + t.title + '</span>').join('');
    } else h += '<span class="tab on">' + this.title + '</span>';
    h += '</div>';
    for (let k = this.top; k < Math.min(items.length, this.top + vis); k++) {
      const more = (k === this.top + vis - 1 && k < items.length - 1) ? '<span class="more">↓</span>' : (k === this.top && k > 0 ? '<span class="more">↑</span>' : '');
      h += '<div class="ln mi' + (k === this.s ? ' on' : '') + '"><span class="mn">' + (k + 1) + ':</span>' + items[k].label + more + '</div>';
    }
    return h + '</div>';
  }
}

// ---------------------------------------------------------------- forms
// rows: {type:'field'|'choice'|'action'|'text', label, ...}; hidden(): bool
class FormScreen extends Screen {
  constructor(app, cfg) {
    super(app);
    this.cfg = cfg; this.rows = cfg.rows; this.r = 0; this.top = 0;
    this.rows.forEach(r => { if (r.type === 'choice') r.cur = r.get(); });
    this.r = this.firstSel();
    this.fresh = true;
  }
  vis() { return this.rows.filter(r => !(r.hidden && r.hidden())); }
  selectable() { return this.vis().filter(r => r.type !== 'text'); }
  firstSel() { const s = this.selectable(); return s.length ? this.vis().indexOf(s[0]) : 0; }
  get row() { return this.vis()[this.r]; }
  editor() { return this.row && this.row.type === 'field' ? this.row.ed : null; }
  validate(row) {
    if (!row || row.type !== 'field' || !row.validate) return true;
    if (!row.ed.items().length && row.allowEmpty) { row.validate(null); return true; }
    const r = evalField(this.app, row.ed.items(), { complex: row.complex });
    row.validate(r);
    return true;
  }
  move(d) {
    const v = this.vis();
    let k = this.r;
    for (;;) {
      k += d;
      if (k < 0 || k >= v.length) return false;
      if (v[k].type !== 'text') break;
    }
    this.validate(this.row);
    this.r = k;
    this.fresh = true;
    return true;
  }
  key(a) {
    const row = this.row;
    if (this.cfg.key && this.cfg.key(a, this)) return true;
    if (a === 'up' || a === 'down') {
      if (row && row.type === 'field' && row.ed[a]()) { this.fresh = false; return true; }
      this.move(a === 'up' ? -1 : 1);
      return true;
    }
    if (!row) return GLOBAL_KEYS.has(a) ? false : true;
    if (row.type === 'choice') {
      if (a === 'left') { row.cur = (row.cur - 1 + row.opts.length) % row.opts.length; return true; }
      if (a === 'right') { row.cur = (row.cur + 1) % row.opts.length; return true; }
      if (a === 'enter') { row.set(row.cur); if (row.after) row.after(); return true; }
    }
    if (row.type === 'action' && a === 'enter') { this.validateAll(); row.run(this); return true; }
    if (row.type === 'field') {
      // Opening a menu does not itself edit the field. Its initial value stays
      // replaceable until an operand is chosen or the cursor is moved.
      if (GLOBAL_KEYS.has(a)) return false;
      // Typing into a field that still shows its old value replaces that value.
      if (this.fresh && !KEEP_KEYS.has(a) && !FIELD_MODIFIERS.has(a)) row.ed.clear();
      this.fresh = false;
      if (a === 'enter') {
        this.validate(row);
        if (row.onEnter) { row.onEnter(this); return true; }
        if (!this.move(1) && this.cfg.onLastEnter) this.cfg.onLastEnter(this);
        return true;
      }
      if (a === 'clear') {
        if (!row.ed.isEmpty()) { row.ed.clear(); return true; }
      } else if (editKey(this.app, row.ed, a, {})) return true;
    }
    if (a === 'clear') { if (this.cfg.onBack) this.cfg.onBack(this); else this.app.pop(); return true; }
    return GLOBAL_KEYS.has(a) ? false : true;
  }
  validateAll() { this.vis().forEach(r => { if (r.type === 'field' && r.ed.items().length) this.validate(r); }); }
  rowHtml(row, cur) {
    const app = this.app;
    switch (row.type) {
      case 'text': return '<div class="ln ft">' + row.html() + '</div>';
      case 'action': return '<div class="ln fa' + (cur ? ' on' : '') + '">' + row.label + '</div>';
      case 'choice': {
        const sel = row.get();
        return '<div class="ln fc">' + (row.label ? '<span class="fl">' + row.label + '</span>' : '') + row.opts.map((o, k) =>
          '<span class="opt' + (k === sel ? ' on' : '') + (cur && k === row.cur ? ' cursor' : '') + (row.tight ? ' tight' : '') + '">' + o + '</span>').join('') + '</div>';
      }
      case 'field':
        return '<div class="ln ff' + (cur ? ' cur-row' : '') + '"><span class="fl">' + row.label + '</span>' +
          (cur ? edHtml(app, row.ed, true) : itemsHtml(app, row.ed.items())) + '</div>';
    }
    return '';
  }
  html() {
    const v = this.vis(), lines = this.cfg.lines || 4;
    const title = this.cfg.title ? (typeof this.cfg.title === 'function' ? this.cfg.title() : this.cfg.title) : null;
    const n = lines - (title ? 1 : 0);
    if (this.r < this.top) this.top = this.r;
    if (this.r >= this.top + n) this.top = this.r - n + 1;
    if (this.top > Math.max(0, v.length - n)) this.top = Math.max(0, v.length - n);
    let h = '<div class="form">' + (title ? '<div class="ln ftitle">' + title + '</div>' : '');
    for (let k = this.top; k < Math.min(v.length, this.top + n); k++) h += this.rowHtml(v[k], k === this.r);
    return h + '</div>';
  }
}

// Scrollable list of label=value lines (statistics results, solver solutions).
class ListScreen extends Screen {
  constructor(app, cfg) { super(app); this.cfg = cfg; this.s = 0; this.top = 0; this.alt = false; }
  lines() { return typeof this.cfg.lines === 'function' ? this.cfg.lines(this) : this.cfg.lines; }
  key(a) {
    const L = this.lines();
    if (a === 'up') { if (this.s > 0) this.s--; return true; }
    if (a === 'down') { if (this.s < L.length - 1) this.s++; return true; }
    if (a === 'toggle') { this.alt = !this.alt; return true; }
    const line = L[this.s];
    if (line && line.choice) {
      if (a === 'left') { line.cur = (line.cur - 1 + line.opts.length) % line.opts.length; return true; }
      if (a === 'right') { line.cur = (line.cur + 1) % line.opts.length; return true; }
    }
    if (a === 'enter') { if (line && line.onEnter) line.onEnter(this); else if (this.cfg.onEnter) this.cfg.onEnter(line, this); return true; }
    if (a === 'clear') { if (this.cfg.onBack) this.cfg.onBack(this); else this.app.pop(); return true; }
    return GLOBAL_KEYS.has(a) ? false : true;
  }
  html() {
    const L = this.lines(), title = this.cfg.title, n = title ? 3 : 4;
    if (this.s < this.top) this.top = this.s;
    if (this.s >= this.top + n) this.top = this.s - n + 1;
    let h = '<div class="list">' + (title ? '<div class="ln ftitle">' + title + '</div>' : '');
    for (let k = this.top; k < Math.min(L.length, this.top + n); k++) {
      const l = L[k], on = k === this.s;
      let body;
      if (l.choice) body = '<span class="fl">' + l.label + '</span>' + l.opts.map((o, j) => '<span class="opt' + (j === l.sel ? ' on' : '') + (on && j === l.cur ? ' cursor' : '') + '">' + o + '</span>').join('');
      else body = '<span class="fl' + (on ? ' on' : '') + '">' + l.label + '</span>' + (l.html ? l.html(this) : '');
      h += '<div class="ln li">' + body + '</div>';
    }
    return h + '</div>';
  }
}

// ---------------------------------------------------------------- grid editors (data, matrix, vector)
class GridScreen extends Screen {
  constructor(app, cfg) { super(app); this.cfg = cfg; this.r = 0; this.c = 0; this.top = 0; this.ed = null; this.rowsVis = cfg.rowsVis || 3; }
  editor() { return this.ed; }
  commit() {
    if (!this.ed) return true;
    const items = this.ed.items();
    if (!items.length) { this.ed = null; return true; }
    const r = evalField(this.app, items);
    this.cfg.set(this.r, this.c, r.value.re);
    this.ed = null;
    return true;
  }
  maxRow(c) { return this.cfg.maxRow(c); }
  key(a) {
    const cfg = this.cfg;
    if (cfg.key && cfg.key(a, this)) return true;
    if ((a === 'up' || a === 'down') && this.ed && this.ed[a]()) return true;
    if (a === 'up' || a === 'down' || a === 'histUp' || a === 'histDown') {
      this.commit();
      if (a === 'up') this.r = Math.max(0, this.r - 1);
      if (a === 'down') this.r = Math.min(this.maxRow(this.c), this.r + 1);
      if (a === 'histUp') this.r = 0;
      if (a === 'histDown') this.r = this.maxRow(this.c);
      return true;
    }
    if ((a === 'left' || a === 'right') && (!this.ed || this.ed.isEmpty())) {
      this.ed = null;
      const nc = this.c + (a === 'left' ? -1 : 1);
      if (nc >= 0 && nc < cfg.cols) { this.c = nc; this.r = Math.min(this.r, this.maxRow(this.c)); }
      return true;
    }
    if (a === 'enter') {
      if (this.ed) { this.commit(); this.advance(); } else if (cfg.onEnterCell) cfg.onEnterCell(this);
      return true;
    }
    if (a === 'clear') {
      if (this.ed && !this.ed.isEmpty()) { this.ed.clear(); return true; }
      if (this.ed) { this.ed = null; return true; }
      if (cfg.onClear) { cfg.onClear(this); return true; }
      this.app.home();
      return true;
    }
    if (a === 'delete' && !this.ed) { if (cfg.del) cfg.del(this.r, this.c); return true; }
    if (cfg.readOnly && cfg.readOnly(this.c)) return GLOBAL_KEYS.has(a) ? false : true;
    if (!this.ed) {
      if (GLOBAL_KEYS.has(a) || ['left', 'right', 'toggle'].includes(a)) return GLOBAL_KEYS.has(a) ? false : true;
      this.ed = new Editor({ maxItems: 40 });
    }
    if (editKey(this.app, this.ed, a, {})) {
      if (this.ed.isEmpty() && a === 'delete') this.ed = null;
      return true;
    }
    return GLOBAL_KEYS.has(a) ? false : true;
  }
  advance() {
    const cfg = this.cfg;
    if (cfg.advance) { cfg.advance(this); return; }
    this.r = Math.min(this.maxRow(this.c), this.r + 1);
  }
  html() {
    const cfg = this.cfg, app = this.app, n = this.rowsVis;
    if (this.r < this.top) this.top = this.r;
    if (this.r >= this.top + n) this.top = this.r - n + 1;
    let h = '<div class="grid g' + cfg.cols + '"><div class="ln gh">';
    for (let c = 0; c < cfg.cols; c++) h += '<span class="gc hd' + (c === this.c ? ' cc' : '') + '">' + cfg.head(c) + '</span>';
    h += '</div>';
    for (let r = this.top; r < this.top + n; r++) {
      h += '<div class="ln gr">';
      for (let c = 0; c < cfg.cols; c++) {
        const v = cfg.get(r, c);
        const on = r === this.r && c === this.c;
        h += '<span class="gc' + (on ? ' on' : '') + '">' + (on && this.ed ? '' : esc(cellText(v))) + '</span>';
      }
      h += '</div>';
    }
    const label = cfg.label(this.r, this.c);
    let bottom;
    if (this.ed) bottom = edHtml(app, this.ed, true);
    else if (cfg.bottom) bottom = cfg.bottom(this.r, this.c);
    else { const v = cfg.get(this.r, this.c); bottom = v == null || v === '' ? '' : valueHtml(app, v, true); }
    h += '<div class="ln gb"><span class="fl">' + label + '</span>' + bottom + '</div>';
    return h + '</div>';
  }
}

// ======================================================================= feature builders
function goHomeAnd(app, fn) { app.home(); fn(); }

function menuEditor(app, preserveValue) {
  const scr = app.top, ed = scr.editor ? scr.editor() : null;
  if (!ed) return;
  if (scr instanceof FormScreen && scr.fresh) {
    if (!preserveValue) ed.clear();
    scr.fresh = false;
  }
  return ed;
}
function pasteTo(app, items, ansFirst) {
  const kind = items.length === 1 && !items[0].t && SYM[items[0].s] ? SYM[items[0].s].k : null;
  const modifier = ['post', 'suf', 'conv', 'bin'].includes(kind);
  const scr = app.top, ed = menuEditor(app, ansFirst || modifier);
  if (!ed) return;
  if (ansFirst && scr instanceof Home && ed.isEmpty()) ed.insert({ s: 'ans' });
  ed.insertMany(items);
}
function tplOrToken(app, tpl, token) {
  const ed = menuEditor(app);
  if (!ed) return;
  if (app.state.settings.mathprint) ed.template(tpl); else ed.insert({ s: token });
}

function mathMenu(app) {
  const tok = (label, s, ansFirst) => ({ label, run: () => pasteTo(app, [{ s }], ansFirst) });
  app.push(new MenuScreen(app, [
    { title: 'MATH', items: [
      tok('►n/d◄►Un/d', 'toFrac', true), tok('lcm(', 'lcm('), tok('gcd(', 'gcd('), tok('►Pfactor', 'toPf', true),
      { label: 'sum(', run: () => tplOrToken(app, 'sum', 'sum(') },
      { label: 'prod(', run: () => tplOrToken(app, 'prod', 'prod(') },
    ] },
    { title: 'NUM', items: [
      { label: 'abs(', run: () => tplOrToken(app, 'abs', 'abs(') },
      tok('round(', 'round('), tok('iPart(', 'iPart('), tok('fPart(', 'fPart('), tok('int(', 'int('),
      tok('min(', 'min('), tok('max(', 'max('), tok('mod(', 'mod('),
    ] },
    { title: 'DMS', items: [tok('°', 'deg'), tok('′', 'min'), tok('″', 'sec'), tok('<span class="sy">ʳ</span>', 'rad'), tok('<span class="sy">ᵍ</span>', 'grad'), tok('►DMS', 'toDMS', true)] },
    { title: 'R◄►P', items: [tok('P►Rx(', 'PRx('), tok('P►Ry(', 'PRy('), tok('R►Pr(', 'RPr('), tok('R►Pθ(', 'RPt(')] },
  ], it => it.run()));
}

function complexMenu(app) {
  const tok = (label, s, ansFirst) => ({ label, run: () => pasteTo(app, [{ s }], ansFirst) });
  app.push(new MenuScreen(app, [{ title: 'COMPLEX', items: [
    tok('∠', 'angle'), tok('polar angle', 'angle('),
    { label: 'magnitude', run: () => tplOrToken(app, 'abs', 'abs(') },
    tok('►r∠θ', 'toPolar', true), tok('►a+bi', 'toRect', true),
    tok('conjugate', 'conj('), tok('real', 'real('), tok('imaginary', 'imag('),
  ] }], it => it.run(), { title: 'COMPLEX' }));
}

function randomMenu(app) {
  app.push(new MenuScreen(app, [{ title: 'RAND', items: [
    { label: 'rand', run: () => pasteTo(app, [{ s: 'rand' }]) },
    { label: 'randint(', run: () => pasteTo(app, [{ s: 'randint(' }]) },
  ] }], it => it.run(), { title: 'RAND' }));
}

function constantsMenu(app) {
  const mk = unitsTab => E.CONSTANTS.map(([id, h, name, unit]) => ({
    label: '<b class="kc">' + h + '</b> <span class="mu">' + esc(unitsTab ? unit : name) + '</span>',
    run: () => pasteTo(app, [{ s: 'K_' + id }]),
  }));
  app.push(new MenuScreen(app, [{ title: 'NAMES', items: mk(false) }, { title: 'UNITS', items: mk(true) }], it => it.run()));
}

function convertMenu(app) {
  app.push(new MenuScreen(app, [{ title: 'CONVERSIONS', items: E.CONVERSIONS.map(([cat, list]) => ({
    label: esc(cat),
    run: () => app.push(new MenuScreen(app, [{ title: cat, items: list.map(([id, label]) => ({
      label: esc(label), run: () => pasteTo(app, [{ s: 'U_' + id }], true),
    })) }], it => it.run(), { title: esc(cat.toUpperCase()) })),
  })) }], it => it.run(), { title: 'CONVERSIONS' }));
}

function baseMenu(app) {
  const tok = (label, s, ansFirst) => ({ label, run: () => pasteTo(app, [{ s }], ansFirst) });
  app.push(new MenuScreen(app, [
    { title: 'CONVR', items: [tok('►Hex', 'toHex', true), tok('►Bin', 'toBin', true), tok('►Dec', 'toDec', true), tok('►Oct', 'toOct', true)] },
    { title: 'TYPE', items: [tok('h', 'sh'), tok('b', 'sb'), tok('d', 'sd'), tok('o', 'so')] },
    { title: 'LOGIC', items: [tok('and', 'and', true), tok('or', 'or', true), tok('xor', 'xor', true), tok('xnor', 'xnor', true),
      tok('not(', 'not('), tok("2's(", 'twos('), tok('nand', 'nand', true)] },
  ], it => it.run()));
}

function recallMenu(app) {
  const st = app.state.settings;
  app.push(new MenuScreen(app, [{ title: 'RECALL VAR', items: 'xyztabcd'.split('').map(v => {
    const val = app.state.vars[v] || cx(0);
    return {
      label: '<i>' + v + '</i> = ' + esc(E.valueText(val, st, false)),
      run: () => {
        const items = val.im !== 0 ? E.complexItems(val, st, false, false) : E.numItems(val.re, st, !(app.state.varApprox || {})[v]);
        pasteTo(app, items.length > 1 ? [{ s: '(' }].concat(items, [{ s: ')' }]) : items);
      },
    };
  }) }], it => it.run(), { title: 'RECALL VAR' }));
}

function yesNo(app, title, yesFirst, onYes) {
  const items = yesFirst ? [{ label: 'Yes', yes: true }, { label: 'No' }] : [{ label: 'No' }, { label: 'Yes', yes: true }];
  app.push(new MenuScreen(app, [{ title, items }], it => { if (it.yes) onYes(); }, { title }));
}

function matrixMenu(app) {
  const S = app.state;
  const dim = m => (m ? ' ' + m.r + '×' + m.c : '');
  const tok = (label, s) => ({ label, run: () => pasteTo(app, [{ s }]) });
  app.push(new MenuScreen(app, [
    { title: 'NAMES', items: [
      tok('[A]' + dim(S.mats.A), 'mA'), tok('[B]' + dim(S.mats.B), 'mB'), tok('[C]' + dim(S.mats.C), 'mC'),
      tok('[Ans]' + (S.ansMat instanceof E.Mat ? dim(S.ansMat) : ''), 'mAns'), tok('[I2]', 'mI2'), tok('[I3]', 'mI3'),
    ] },
    { title: 'MATH', items: [tok('Determinant', 'det('), tok('<span class="sy">ᵀ</span> Transpose', 'T'), tok('<span class="sy">⁻¹</span> Inverse', 'inv'),
      tok('ref', 'ref('), tok('rref', 'rref(')] },
    { title: 'EDIT', items: ['A', 'B', 'C'].map(n => ({ label: '[' + n + ']' + dim(S.mats[n]), run: () => goHomeAnd(app, () => matDims(app, n)) })) },
  ], it => it.run()));
}
function matDims(app, name) {
  const S = app.state, m = S.mats[name];
  let r = m ? m.r - 1 : 1, c = m ? m.c - 1 : 1;
  app.push(new FormScreen(app, {
    title: 'MATRIX [' + name + ']',
    rows: [
      { type: 'choice', label: 'rows:', opts: ['1', '2', '3'], get: () => r, set: v => { r = v; } },
      { type: 'choice', label: 'cols:', opts: ['1', '2', '3'], get: () => c, set: v => { c = v; } },
      { type: 'action', label: 'OK', run: () => {
        const old = S.mats[name];
        const rows = Array.from({ length: r + 1 }, (_, i) => Array.from({ length: c + 1 }, (_, j) => (old && old.rows[i] && old.rows[i][j] != null ? old.rows[i][j] : 0)));
        S.mats[name] = new E.Mat(rows);
        app.save();
        app.pop();
        matEdit(app, name);
      } },
    ],
  }));
}
function matEdit(app, name) {
  const S = app.state;
  app.push(new GridScreen(app, {
    cols: S.mats[name].c,
    head: c => 'col ' + (c + 1),
    get: (r, c) => (r < S.mats[name].r ? S.mats[name].rows[r][c] : ''),
    set: (r, c, v) => { S.mats[name].rows[r][c] = v; app.save(); },
    maxRow: () => S.mats[name].r - 1,
    label: (r, c) => name + '(' + (r + 1) + ',' + (c + 1) + ')=',
    advance: g => {
      if (g.c < S.mats[name].c - 1) g.c++;
      else if (g.r < S.mats[name].r - 1) { g.c = 0; g.r++; }
    },
  }));
}

function vectorMenu(app) {
  const S = app.state;
  const dim = v => (v ? ' dim=' + v.a.length : '');
  const tok = (label, s) => ({ label, run: () => pasteTo(app, [{ s }]) });
  app.push(new MenuScreen(app, [
    { title: 'NAMES', items: [tok('[u]' + dim(S.vecs.u), 'vU'), tok('[v]' + dim(S.vecs.v), 'vV'), tok('[w]' + dim(S.vecs.w), 'vW'),
      tok('[Ans]' + (S.ansMat instanceof E.Vec ? dim(S.ansMat) : ''), 'vAns')] },
    { title: 'MATH', items: [tok('DotProduct', 'DotP('), tok('CrossProduct', 'CrossP('), tok('norm magnitude', 'norm(')] },
    { title: 'EDIT', items: ['u', 'v', 'w'].map(n => ({ label: '[' + n + ']' + dim(S.vecs[n]), run: () => goHomeAnd(app, () => vecDims(app, n)) })) },
  ], it => it.run()));
}
function vecDims(app, name) {
  const S = app.state, v = S.vecs[name];
  let d = v ? Math.max(0, v.a.length - 2) : 0;
  app.push(new FormScreen(app, {
    title: 'VECTOR [' + name + ']',
    rows: [
      { type: 'choice', label: 'dim:', opts: ['2', '3'], get: () => d, set: x => { d = x; } },
      { type: 'action', label: 'OK', run: () => {
        const old = S.vecs[name], n = d + 2;
        S.vecs[name] = new E.Vec(Array.from({ length: n }, (_, k) => (old && old.a[k] != null ? old.a[k] : 0)));
        app.save(); app.pop();
        app.push(new GridScreen(app, {
          cols: n, rowsVis: 1,
          head: c => name + '<sub>' + (c + 1) + '</sub>',
          get: (r, c) => S.vecs[name].a[c], set: (r, c, x) => { S.vecs[name].a[c] = x; app.save(); },
          maxRow: () => 0, label: (r, c) => name + (c + 1) + '=',
          advance: g => { if (g.c < n - 1) g.c++; },
        }));
      } },
    ],
  }));
}

// ---------------------------------------------------------------- data editor and list formulas
const LISTS = ['L1', 'L2', 'L3'];
function recomputeFormulas(app, nextLists, nextFormulas) {
  const S = app.state;
  const source = nextLists || S.lists, formulas = nextFormulas || S.formulas;
  const lists = Object.fromEntries(LISTS.map(L => [L, source[L].slice()]));
  // Evaluate dependent columns before their users, keeping all edits staged
  // until every formula succeeds. Cycles must leave existing data intact.
  const work = Object.assign({}, S, { lists, formulas,
    vars: Object.assign({}, S.vars), varApprox: Object.assign({}, S.varApprox),
    mats: Object.assign({}, S.mats), vecs: Object.assign({}, S.vecs), rng: Object.assign({}, S.rng) });
  const visiting = new Set(), done = new Set();
  const visit = L => {
    if (done.has(L) || !formulas[L]) return;
    if (visiting.has(L)) throw new CalcError('FORMULA');
    visiting.add(L);
    LISTS.filter(dep => contains(formulas[L], dep)).forEach(visit);
    const v = E.evaluate(formulas[L], work).value;
    if (E.isCx(v)) throw new CalcError('FORMULA');
    if (!(v instanceof E.List)) throw new CalcError('DATA TYPE');
    lists[L] = v.a.slice(0, 42);
    visiting.delete(L);
    done.add(L);
  };
  LISTS.forEach(visit);
  S.lists = lists;
  S.formulas = Object.assign({}, formulas);
  S.rng = work.rng;
}
function dataEditor(app) {
  const S = app.state;
  const g = new GridScreen(app, {
    cols: 3,
    head: c => (S.formulas[LISTS[c]] ? '<span class="fx">' + LISTS[c] + '</span>' : LISTS[c]),
    get: (r, c) => S.lists[LISTS[c]][r],
    set: (r, c, v) => {
      if (r >= 42) return;
      const nextLists = Object.assign({}, S.lists, { [LISTS[c]]: S.lists[LISTS[c]].slice() });
      nextLists[LISTS[c]][r] = v;
      recomputeFormulas(app, nextLists);
      app.save();
    },
    del: (r, c) => {
      if (S.formulas[LISTS[c]]) return;
      const nextLists = Object.assign({}, S.lists, { [LISTS[c]]: S.lists[LISTS[c]].slice() });
      nextLists[LISTS[c]].splice(r, 1);
      recomputeFormulas(app, nextLists); app.save();
    },
    maxRow: c => Math.min(41, S.lists[LISTS[c]].length),
    readOnly: c => !!S.formulas[LISTS[c]],
    label: (r, c) => (S.formulas[LISTS[c]] ? LISTS[c] + '=' : LISTS[c] + '(' + (r + 1) + ')='),
    bottom: (r, c) => {
      const f = S.formulas[LISTS[c]];
      if (f) return itemsHtml(app, f);
      const v = S.lists[LISTS[c]][r];
      return v == null ? '' : valueHtml(app, v, true);
    },
    key: (a, grid) => {
      if (a === 'data') { dataMenu(app, grid); return true; }
      return false;
    },
  });
  g.rowsVis = 3;
  app.push(g);
}
function dataMenu(app, grid) {
  const S = app.state;
  const clearL = L => {
    recomputeFormulas(app, Object.assign({}, S.lists, { [L]: [] }), Object.assign({}, S.formulas, { [L]: null }));
    app.save();
  };
  app.push(new MenuScreen(app, [
    { title: 'CLEAR', items: [
      ...LISTS.map(L => ({ label: 'Clear ' + L, run: () => clearL(L) })),
      { label: 'Clear ALL', run: () => {
        recomputeFormulas(app, { L1: [], L2: [], L3: [] }, { L1: null, L2: null, L3: null }); app.save();
      } },
    ] },
    { title: 'FORMULA', items: [
      { label: 'Add/Edit Frmla', run: () => formulaEdit(app, LISTS[grid.c]) },
      ...LISTS.map(L => ({ label: 'Clear ' + L + ' frmla', run: () => { S.formulas[L] = null; app.save(); } })),
      { label: 'Clear ALL frmlas', run: () => { LISTS.forEach(L => { S.formulas[L] = null; }); app.save(); } },
    ] },
  ], it => it.run()));
}
function formulaEdit(app, L) {
  const S = app.state;
  const ed = fieldFor(S.formulas[L] || []);
  app.push(new FormScreen(app, {
    title: 'Formula',
    rows: [{ type: 'field', label: L + '=', ed, onEnter: () => {
      const items = ed.items();
      if (!items.length) { S.formulas[L] = null; app.save(); app.pop(); return; }
      const uses = LISTS.filter(x => contains(items, x));
      if (!uses.length || uses.includes(L)) throw new CalcError('FORMULA');
      recomputeFormulas(app, null, Object.assign({}, S.formulas, { [L]: clone(items) }));
      app.save();
      app.pop();
    } }],
    key: a => {
      if (a === 'data') {
        app.push(new MenuScreen(app, [{ title: 'LISTS', items: LISTS.map(x => ({ label: x, run: () => pasteTo(app, [{ s: x }]) })) }], it => it.run(), { title: 'LISTS' }));
        return true;
      }
      return false;
    },
  }));
}

// ---------------------------------------------------------------- statistics
function statMenu(app) {
  const S = app.state;
  const kinds = [['lin', 'LinReg ax+b'], ['quad', 'QuadraticReg'], ['cubic', 'CubicReg'], ['ln', 'LnReg a+blnx'], ['pwr', 'PwrReg ax^b'], ['exp', 'ExpReg ab^x']];
  app.push(new MenuScreen(app, [
    { title: 'STATS', items: [
      { label: 'StatVars', run: () => statVars(app) },
      { label: '1-Var Stats', run: () => goHomeAnd(app, () => statWizard(app, '1var')) },
      { label: '2-Var Stats', run: () => goHomeAnd(app, () => statWizard(app, '2var')) },
      ...kinds.map(([k, label]) => ({ label: esc(label), run: () => goHomeAnd(app, () => statWizard(app, k)) })),
    ] },
    { title: 'DISTR', items: [
      ['npdf', 'Normalpdf'], ['ncdf', 'Normalcdf'], ['inv', 'invNorm'], ['bpdf', 'Binompdf'], ['bcdf', 'Binomcdf'], ['ppdf', 'Poissonpdf'], ['pcdf', 'Poissoncdf'],
    ].map(([k, label]) => ({ label, run: () => goHomeAnd(app, () => distWizard(app, k, label)) })) },
  ], it => it.run()));
}
function statWizard(app, kind) {
  const S = app.state, cfgS = S.statCfg;
  const two = kind !== '1var';
  let regEq = 0;
  const rows = [];
  if (!two) rows.push({ type: 'choice', label: 'DATA:', opts: LISTS, get: () => cfgS.x, set: v => { cfgS.x = v; } });
  else {
    rows.push({ type: 'choice', label: 'xDATA:', opts: LISTS, get: () => cfgS.x, set: v => { cfgS.x = v; } });
    rows.push({ type: 'choice', label: 'yDATA:', opts: LISTS, get: () => cfgS.y, set: v => { cfgS.y = v; } });
  }
  rows.push({ type: 'choice', label: 'FRQ:', opts: ['ONE'].concat(LISTS), get: () => cfgS.f, set: v => { cfgS.f = v; } });
  if (two && kind !== '2var') rows.push({ type: 'choice', label: 'RegEQ:', opts: ['NO', 'YES'], get: () => regEq, set: v => { regEq = v; } });
  rows.push({ type: 'action', label: 'CALC', run: () => {
    const x = LISTS[cfgS.x], y = LISTS[cfgS.y], f = cfgS.f ? LISTS[cfgS.f - 1] : 'ONE';
    let res;
    if (kind === '1var') res = E.oneVar(S, x, f);
    else if (kind === '2var') res = E.twoVar(S, x, y, f);
    else res = E.regression(S, kind, x, y, f);
    res.desc = res.title + (two ? ':' + x + ',' + y : ':' + x) + ',' + f;
    S.stat = { vars: res.vars, order: res.order, title: res.title, desc: res.desc, lin: !!res.lin };
    if (res.eq && regEq) S.fx = E.regEqItems(res.eq);
    app.save();
    app.pop();
    statResults(app);
  } });
  const titles = { '1var': '1-Var Stats', '2var': '2-Var Stats', lin: 'LinReg ax+b', quad: 'QuadraticReg', cubic: 'CubicReg', ln: 'LnReg a+blnx', pwr: 'PwrReg ax^b', exp: 'ExpReg ab^x' };
  app.push(new FormScreen(app, { title: esc(titles[kind]), rows }));
}
function statLines(app, pasteable) {
  const S = app.state, sv = S.stat;
  return sv.order.map(id => {
    const isFn = id === 'S_xp(' || id === 'S_yp(';
    const label = esc(E.SYM[id].d) + (isFn ? '' : '=');
    return {
      label,
      html: () => (isFn ? '' : valueHtml(app, sv.vars[id], false)),
      onEnter: pasteable ? () => { app.home(); app.top.ed.insert({ s: id }); } : null,
    };
  });
}
function statResults(app) {
  const S = app.state;
  app.push(new ListScreen(app, { title: esc(S.stat.desc || S.stat.title), lines: statLines(app, true) }));
}
function statVars(app) {
  const S = app.state;
  if (!S.stat) { app.push(new MsgScreen(app, ['No StatVars yet.', 'Run 1-Var Stats,', '2-Var Stats or a', 'regression first.'])); return; }
  app.push(new ListScreen(app, { title: esc(S.stat.desc || S.stat.title), lines: statLines(app, true) }));
}

// ---------------------------------------------------------------- distributions
function distWizard(app, kind, title) {
  const S = app.state;
  let mode = 0, listIn = 0, saveTo = 1;
  const F = (label, val) => ({ type: 'field', label, ed: fieldFor(val) });
  const rows = [];
  const single = () => mode === 0, isList = () => mode === 1, isAll = () => mode === 2;
  const discrete = ['bpdf', 'bcdf', 'ppdf', 'pcdf'].includes(kind);
  if (discrete) rows.push({ type: 'choice', label: '', opts: kind[0] === 'b' ? ['SINGLE', 'LIST', 'ALL'] : ['SINGLE', 'LIST'], get: () => mode, set: v => { mode = v; } });
  const fields = {};
  const add = (key, label, val, hidden) => { const f = F(label, val); if (hidden) f.hidden = hidden; fields[key] = f; rows.push(f); };
  switch (kind) {
    case 'npdf': add('x', 'x=', 0); add('mu', 'μ=', 0); add('s', 'σ=', 1); break;
    case 'ncdf': add('lo', 'LOWER=', [{ s: 'neg' }, { s: '1' }, { s: 'E' }, { s: '9' }, { s: '9' }]); add('hi', 'UPPER=', [{ s: '1' }, { s: 'E' }, { s: '9' }, { s: '9' }]); add('mu', 'μ=', 0); add('s', 'σ=', 1); break;
    case 'inv': add('area', 'area=', 1); add('mu', 'μ=', 0); add('s', 'σ=', 1); break;
    case 'bpdf': case 'bcdf': add('n', 'n=', 0); add('p', 'p=', 0); add('x', 'x=', 0, () => !single()); break;
    case 'ppdf': case 'pcdf': add('mu', 'μ=', 0); add('x', 'x=', 0, () => !single()); break;
  }
  if (discrete) {
    rows.push({ type: 'choice', label: 'x LIST:', opts: LISTS, get: () => listIn, set: v => { listIn = v; }, hidden: () => !isList() });
    rows.push({ type: 'choice', label: 'SAVE:', opts: LISTS, get: () => saveTo, set: v => { saveTo = v; }, hidden: () => single() });
  }
  rows.push({ type: 'action', label: 'CALC', run: () => {
    // Parameters can include rand; keep their effects staged until success too.
    const staged = { state: Object.assign({}, S, {
      vars: Object.assign({}, S.vars), varApprox: Object.assign({}, S.varApprox), rng: Object.assign({}, S.rng),
    }) };
    const work = staged.state;
    const val = k => evalField(staged, fields[k].ed.items()).value.re;
    const commit = () => Object.assign(S, {
      vars: work.vars, varApprox: work.varApprox, rng: work.rng, lists: work.lists, formulas: work.formulas,
    });
    let out;
    switch (kind) {
      case 'npdf': out = E.normalPdf(val('x'), val('mu'), val('s')); break;
      case 'ncdf': out = E.normalCdf(val('lo'), val('hi'), val('mu'), val('s')); break;
      case 'inv': out = E.invNorm(val('area'), val('mu'), val('s')); break;
      default: {
        const fn = { bpdf: E.binomPdf, bcdf: E.binomCdf, ppdf: E.poissonPdf, pcdf: E.poissonCdf }[kind];
        const params = kind[0] === 'b' ? [val('n'), val('p')] : [val('mu')];
        const call = x => fn(...params, x);
        if (single()) out = call(val('x'));
        else {
          // Validate parameters before allocating ALL's results or reading a list.
          call(0);
          let xs;
          if (isAll()) xs = Array.from({ length: Math.round(params[0]) + 1 }, (_, k) => k);
          else xs = work.lists[LISTS[listIn]].slice();
          if (!xs.length) throw new CalcError('STAT');
          const ys = xs.map(call).map(E.round14).slice(0, 42);
          const dest = LISTS[saveTo];
          recomputeFormulas(staged, Object.assign({}, work.lists, { [dest]: ys }), Object.assign({}, work.formulas, { [dest]: null }));
          commit();
          app.save();
          app.push(new ListScreen(app, { title: esc(title) + '→' + LISTS[saveTo], lines: ys.map((y, k) => ({ label: 'x=' + esc(cellText(xs[k])) + ':', html: () => valueHtml(app, y, false) })) }));
          return;
        }
      }
    }
    out = E.round14(out);
    commit();
    S.ans = cx(out); S.ansApprox = true;
    app.save();
    app.push(new ListScreen(app, { title: esc(title), lines: [{ label: kind === 'inv' ? 'x=' : 'P=', html: () => valueHtml(app, out, false) }] }));
  } });
  app.push(new FormScreen(app, { title: esc(title), rows }));
}

// ---------------------------------------------------------------- function table
function tableMenu(app) {
  app.push(new MenuScreen(app, [{ title: 'TABLE', items: [
    { label: 'f(', run: () => pasteTo(app, [{ s: 'f(' }]) },
    { label: 'Edit function', run: () => goHomeAnd(app, () => funcEdit(app)) },
  ] }], it => it.run(), { title: 'TABLE' }));
}
function funcEdit(app) {
  const S = app.state, ed = fieldFor(S.fx || []);
  app.push(new FormScreen(app, {
    title: 'Edit function',
    rows: [{ type: 'field', label: 'f(<i>x</i>)=', ed, onEnter: () => {
      const items = ed.items();
      if (!items.length) throw new CalcError('INVALID FUNCTION');
      E.parseItems(items, E.makeCtx(S));
      S.fx = clone(items);
      app.save();
      app.pop();
      tableSetup(app);
    } }],
  }));
}
function tableSetup(app) {
  const S = app.state, T = S.table;
  const start = fieldFor(T.start), step = fieldFor(T.step);
  let auto = T.auto ? 0 : 1;
  app.push(new FormScreen(app, {
    title: 'f(<i>x</i>)=' + itemsHtml(app, S.fx),
    rows: [
      { type: 'field', label: 'Start=', ed: start, validate: r => { T.start = r.value.re; } },
      { type: 'field', label: 'Step=', ed: step, validate: r => { if (r.value.re === 0) throw new CalcError('DOMAIN'); T.step = r.value.re; } },
      { type: 'choice', label: '', opts: ['Auto', 'Ask-<i>x</i>'], get: () => auto, set: v => { auto = v; } },
      { type: 'action', label: 'CALC', run: () => { T.auto = auto === 0; if (!T.auto) T.askX = []; app.save(); app.pop(); tableView(app); } },
    ],
  }));
}
function tableView(app) {
  const S = app.state, T = S.table;
  let base = 0;
  const xAt = r => (T.auto ? E.round14(T.start + (base + r) * T.step) : T.askX[r]);
  const fAt = r => {
    const x = xAt(r);
    if (x == null) return '';
    try {
      const v = E.evalWith(E.parseItems(S.fx, E.makeCtx(S)), { x: cx(x) }, E.makeCtx(S));
      if (!E.isCx(v) || v.im !== 0) return 'Error';
      return E.round14(v.re);
    } catch (e) { return 'Error'; }
  };
  const g = new GridScreen(app, {
    cols: 2,
    head: c => (c === 0 ? '<i>x</i>' : 'f(<i>x</i>)'),
    get: (r, c) => (c === 0 ? xAt(r) : fAt(r)),
    set: (r, c, v) => { if (!T.auto && c === 0) { T.askX[r] = v; app.save(); } },
    maxRow: () => (T.auto ? 1e9 : Math.min(41, T.askX.length)),
    readOnly: c => T.auto || c === 1,
    label: (r, c) => (c === 0 ? '<i>x</i>=' : 'f(<i>x</i>)='),
    key: (a, grid) => {
      if (T.auto && a === 'up' && grid.r === grid.top && grid.r === 0) { base--; return true; }
      return false;
    },
  });
  app.push(g);
}

// ---------------------------------------------------------------- solvers
function numSolv(app) {
  const S = app.state;
  const lhs = new Editor({ items: S.numsolv.lhs, maxItems: 40 }), rhs = new Editor({ items: S.numsolv.rhs, maxItems: 40 });
  let side = 0;
  const scr = new Screen(app);
  scr.editor = () => (side ? rhs : lhs);
  scr.key = a => {
    const ed = side ? rhs : lhs;
    if (a === 'right' && ed === lhs && lhs.i === lhs.row.length && !lhs.path.length) { side = 1; rhs.home(); return true; }
    if (a === 'left' && ed === rhs && rhs.i === 0 && !rhs.path.length) { side = 0; lhs.end(); return true; }
    if (a === 'enter') {
      if (!lhs.items().length || !rhs.items().length) throw new CalcError('INVALID EQUATION');
      const ctx = E.makeCtx(S);
      E.parseItems(lhs.items(), ctx); E.parseItems(rhs.items(), ctx);
      S.numsolv = { lhs: clone(lhs.items()), rhs: clone(rhs.items()) };
      const vars = 'xyztabcd'.split('').filter(v => contains(lhs.items(), v) || contains(rhs.items(), v));
      if (!vars.length) throw new CalcError('INVALID EQUATION');
      app.save();
      numSolvVars(app, vars);
      return true;
    }
    if (a === 'clear') { if (!ed.isEmpty()) ed.clear(); else app.home(); return true; }
    if (editKey(app, ed, a, {})) return true;
    return GLOBAL_KEYS.has(a) ? false : true;
  };
  scr.html = () => '<div class="form"><div class="ln ftitle">Eqn:</div><div class="ln ff eqn">' +
    edHtml(app, lhs, side === 0) + '<span class="sy op">=</span>' + edHtml(app, rhs, side === 1) + '</div>' +
    '<div class="ln hint">enter: set values</div></div>';
  app.push(scr);
}
function numSolvVars(app, vars) {
  const S = app.state;
  const rows = vars.map(v => {
    const val = S.vars[v] || cx(0);
    return {
      type: 'field', label: '<i>' + v + '</i>=', ed: fieldFor(val.im ? 0 : val.re), v,
      validate: r => { S.vars[v] = cx(r.value.re); },
      onEnter: f => {
        f.validateAll();
        const guess = (S.vars[v] || cx(0)).re;
        const res = E.numSolve(S.numsolv.lhs, S.numsolv.rhs, v, guess, S);
        S.vars[v] = cx(res.x);
        if (S.varApprox) S.varApprox[v] = true;
        rows.find(r => r.v === v).ed = fieldFor(res.x);
        app.save();
        app.push(new ListScreen(app, { title: 'Solution', lines: [
          { label: '<i>' + v + '</i>=', html: () => valueHtml(app, res.x, false) },
          { label: 'Left−Rt=', html: () => valueHtml(app, res.diff, false) },
        ] }));
      },
    };
  });
  app.push(new FormScreen(app, {
    title: () => 'Eqn: ' + itemsHtml(app, S.numsolv.lhs) + '=' + itemsHtml(app, S.numsolv.rhs),
    rows: rows.concat([{ type: 'text', html: () => '<span class="hint">Cursor on a variable, enter = solve</span>' }]),
  }));
}

function polyMenu(app) {
  app.push(new MenuScreen(app, [{ title: 'POLY-SOLV', items: [
    { label: 'a<i>x</i>²+b<i>x</i>+c', deg: 2 }, { label: 'a<i>x</i>³+b<i>x</i>²+c<i>x</i>+d', deg: 3 },
  ] }], it => goHomeAnd(app, () => polyForm(app, it.deg)), { title: 'POLY-SOLV' }));
}
function polyForm(app, deg) {
  const S = app.state, names = deg === 2 ? ['a', 'b', 'c'] : ['a', 'b', 'c', 'd'];
  const coef = {}, approx = {};
  const rows = names.map(n => {
    const v = S.vars[n] || cx(0);
    coef[n] = v.re;
    return { type: 'field', label: n + '=', ed: fieldFor(v.im ? 0 : v.re), validate: r => {
      if (n === 'a' && r.value.re === 0) throw new CalcError('Highest Degree coefficient cannot be zero');
      coef[n] = r.value.re; approx[n] = r.approx;
    } };
  });
  rows.push({ type: 'action', label: 'SOLVE', run: () => {
    if (coef.a === 0) throw new CalcError('Highest Degree coefficient cannot be zero');
    polyResults(app, deg, coef, Object.values(approx).some(Boolean));
  } });
  const title = deg === 2 ? 'a<i>x</i>²+b<i>x</i>+c=0' : 'a<i>x</i>³+b<i>x</i>²+c<i>x</i>+d=0';
  app.push(new FormScreen(app, { title, rows }));
}
function polyResults(app, deg, k, approx) {
  const S = app.state, st = S.settings;
  let roots, exact = null, q = null;
  if (deg === 2) { q = E.quadSolve(k.a, k.b, k.c, st); roots = q.roots; exact = approx ? null : q.exact; }
  else roots = E.cubicSolve(k.a, k.b, k.c, k.d);
  const show = (z, ex, scr) => {
    if (ex && !scr.alt) return itemsHtml(app, ex);
    const items = z.im !== 0 ? E.complexItems(z, Object.assign({}, st, { cplx: 'RECT' }), !approx && !scr.alt, false) : E.numItems(z.re, st, !approx && !scr.alt);
    return itemsHtml(app, items);
  };
  const lines = roots.map((z, i) => ({ label: '<i>x</i><sub>' + (i + 1) + '</sub>=', html: scr => show(z, exact && exact[i], scr) }));
  if (q) {
    lines.push({ label: '<i>x</i>=−b/2a=', html: scr => valueHtml(app, q.h, !approx && !scr.alt) });
    lines.push({ label: '<i>y</i>=k=', html: scr => valueHtml(app, q.k, !approx && !scr.alt) });
    lines.push({ label: 'Δ=b²−4ac=', html: scr => valueHtml(app, q.D, !approx && !scr.alt) });
  }
  const store = { choice: true, label: 'Store f(<i>x</i>):', opts: ['NO', 'YES'], sel: 0, cur: 0 };
  store.onEnter = () => {
    store.sel = store.cur;
    if (store.cur === 1) {
      const X = { s: 'x' }, n = x => E.numItems(x, st, !approx);
      const sign = x => (x < 0 ? [{ s: '-' }].concat(n(-x)) : [{ s: '+' }].concat(n(x)));
      const names = deg === 2 ? ['a', 'b', 'c'] : ['a', 'b', 'c', 'd'];
      let items = [];
      names.forEach((nm, i) => {
        const p = deg - i, c = k[nm];
        const term = p === 0 ? [] : p === 1 ? [X] : [X, { t: 'pow', a: [[{ s: String(p) }]] }];
        items = items.concat(i === 0 ? n(c) : sign(c), term);
      });
      S.fx = items;
      app.save();
    }
  };
  lines.push(store);
  app.push(new ListScreen(app, { title: deg === 2 ? 'Solutions' : 'Solutions', lines }));
}

function sysMenu(app) {
  app.push(new MenuScreen(app, [{ title: 'SYS-SOLV', items: [{ label: '2×2 system', n: 2 }, { label: '3×3 system', n: 3 }] }],
    it => goHomeAnd(app, () => sysEdit(app, it.n)), { title: 'SYS-SOLV' }));
}
function sysEdit(app, n) {
  const S = app.state;
  if (!S.sys[n]) S.sys[n] = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  const M = S.sys[n], names = n === 2 ? ['x', 'y'] : ['x', 'y', 'z'];
  const g = new GridScreen(app, {
    cols: n + 1, rowsVis: n,
    head: c => (c < n ? '<i>' + names[c] + '</i>' : '='),
    get: (r, c) => M[r][c],
    set: (r, c, v) => { M[r][c] = v; app.save(); },
    maxRow: () => n - 1,
    label: (r, c) => 'Eq' + (r + 1) + (c < n ? ' ' + names[c] + ':' : ' =:'),
    advance: gr => {
      if (gr.c < n) gr.c++;
      else if (gr.r < n - 1) { gr.c = 0; gr.r++; }
      else sysSolve(app, n);
    },
    onEnterCell: gr => gr.cfg.advance(gr),
  });
  g.html = function () {
    const app2 = this.app;
    let h = '<div class="form">';
    for (let r = 0; r < n; r++) {
      h += '<div class="ln sys">';
      for (let c = 0; c <= n; c++) {
        const on = r === this.r && c === this.c;
        const txt = on && this.ed ? edHtml(app2, this.ed, true) : esc(cellText(M[r][c]));
        h += (c === n ? '<span class="sy op">=</span>' : (c > 0 ? '<span class="sy op">+</span>' : '')) +
          '<span class="sc' + (on ? ' on' : '') + '">' + txt + '</span>' + (c < n ? '<i>' + names[c] + '</i>' : '');
      }
      h += '</div>';
    }
    if (n === 2) h += '<div class="ln hint">enter after last = solve</div>';
    return h + '</div>';
  };
  app.push(g);
}
function sysSolve(app, n) {
  const S = app.state, st = S.settings, M = S.sys[n], names = n === 2 ? ['x', 'y'] : ['x', 'y', 'z'];
  const sol = E.linSystem(M.map(r => r.slice()));
  if (sol.type === 'none') { app.push(new MsgScreen(app, ['No Solution Found'])); return; }
  if (sol.type === 'inf' && n === 2) { app.push(new MsgScreen(app, ['Infinite Solutions'])); return; }
  let lines;
  if (sol.type === 'inf') {
    const exprs = E.linInfiniteItems(sol, names, st);
    lines = names.map((nm, k) => ({ label: '<i>' + nm + '</i>=', html: () => itemsHtml(app, exprs[k]) }));
    lines.unshift({ label: 'Infinite solutions', html: () => '' });
  } else {
    sol.x.forEach((v, k) => { S.vars[names[k]] = cx(v); S.varApprox[names[k]] = false; });
    app.save();
    lines = names.map((nm, k) => ({ label: '<i>' + nm + '</i>=', html: scr => valueHtml(app, sol.x[k], !scr.alt) }));
  }
  app.push(new ListScreen(app, { title: 'Solution', lines }));
}

function exprEval(app, initial) {
  const S = app.state, ed = fieldFor(initial && initial.length ? initial : S.exprEval);
  app.push(new FormScreen(app, {
    title: 'Expression eval',
    rows: [{ type: 'field', label: 'Expr=', ed, onEnter: () => {
      const items = ed.items();
      if (!items.length) throw new CalcError('INVALID EQUATION');
      E.parseItems(items, E.makeCtx(S));
      S.exprEval = clone(items);
      app.save();
      const vars = 'xyztabcd'.split('').filter(v => contains(items, v));
      const scope = {};
      let result = null;
      const compute = () => { result = E.evaluate(items, S, { scope }); S.ans = result.value; S.ansApprox = result.approx; app.save(); };
      const rows = vars.map(v => {
        const val = S.vars[v] || cx(0);
        scope[v] = val;
        const value = val.im ? numItems(E.round14(val.re)).concat(
          { s: val.im < 0 ? '-' : '+' }, numItems(E.round14(Math.abs(val.im))), { s: 'i' }) : val.re;
        return { type: 'field', label: '<i>' + v + '</i>=', ed: fieldFor(value), complex: true, validate: r => { scope[v] = r.value; } };
      });
      if (!vars.length) compute();
      rows.push({ type: 'text', html: () => (result ? '= ' + itemsHtml(app, E.resultItems(result, S.settings, false)) : '') });
      app.push(new FormScreen(app, {
        title: 'Expr=' + itemsHtml(app, items), rows,
        onLastEnter: () => compute(),
      }));
      const f = app.top;
      if (vars.length) {
        const last = rows[vars.length - 1];
        last.onEnter = () => { f.validateAll(); compute(); };
      }
    } }],
  }));
}

function setOp(app) {
  const S = app.state, ed = fieldFor(S.op || []);
  app.push(new FormScreen(app, {
    title: 'Set operation',
    rows: [{ type: 'field', label: 'op=', ed, onEnter: () => {
      const items = ed.items();
      S.op = items.length ? clone(items) : null;
      app.save();
      app.home();
    } }],
  }));
}

// ---------------------------------------------------------------- math drill
const DRILL_EXIT_KEYS = new Set(['quit', 'mode', 'off', 'on', 'contrastUp', 'contrastDown']);
class MathDrillScreen extends Screen {
  constructor(app, mode) {
    super(app); this.isMathDrill = true;
    this.session = new TI.mathDrill.Session(mode);
    this.answer = ''; this.cursor = 0; this.feedback = ''; this.replace = false;
  }
  clearAnswer() { this.answer = ''; this.cursor = 0; this.feedback = ''; this.replace = false; }
  next() { this.session.next(); this.clearAnswer(); }
  key(a) {
    if (DRILL_EXIT_KEYS.has(a)) return false;
    if (this.session.solved) {
      if (a === 'enter' || a === 'clear') this.next();
      return true;
    }
    if (a === 'enter') {
      const result = this.session.submit(this.answer);
      this.feedback = result === 'correct' ? 'Correct! enter→next' : result === 'wrong' ? 'Try again' : 'Type an answer';
      this.replace = result === 'wrong';
      return true;
    }
    if (a === 'clear') { this.clearAnswer(); return true; }
    if (a === 'left' || a === 'lhome') { this.cursor = a === 'lhome' ? 0 : Math.max(0, this.cursor - 1); this.replace = false; return true; }
    if (a === 'right' || a === 'lend') { this.cursor = a === 'lend' ? this.answer.length : Math.min(this.answer.length, this.cursor + 1); this.replace = false; return true; }
    if (a === 'delete') {
      if (this.cursor) { this.answer = this.answer.slice(0, this.cursor - 1) + this.answer.slice(this.cursor); this.cursor--; }
      this.feedback = ''; this.replace = false; return true;
    }
    if (a === 'neg' || a === 'sub') {
      if (this.replace) this.clearAnswer();
      if (this.answer.startsWith('-')) { this.answer = this.answer.slice(1); this.cursor = Math.max(0, this.cursor - 1); }
      else if (this.answer.length < 6) { this.answer = '-' + this.answer; this.cursor++; }
      this.feedback = ''; return true;
    }
    if (/^[0-9]$/.test(a) || a === '.') {
      if (this.replace) this.clearAnswer();
      if (a === '.' && this.answer.includes('.')) return true;
      if (this.answer.length < 6) {
        this.answer = this.answer.slice(0, this.cursor) + a + this.answer.slice(this.cursor); this.cursor++;
      }
      this.feedback = ''; return true;
    }
    if (a !== 'up' && a !== 'down' && a !== 'histUp' && a !== 'histDown') this.feedback = 'Use number keys';
    return true;
  }
  html() {
    const s = this.session, q = s.question;
    const answer = this.answer.replace(/-/g, '−');
    const cursor = s.solved ? '' : '<span class="cur-ins"></span>';
    return '<div class="math-drill"><div class="ln drill-title">Math drill ' + s.short + '</div>' +
      '<div class="ln drill-score">First try: ' + s.firstCorrect + '/' + s.answered + '</div>' +
      '<div class="ln entry drill-problem">' + q.a + q.symbol + q.b + '=' +
      '<span class="drill-answer">' + esc(answer.slice(0, this.cursor)) + cursor + esc(answer.slice(this.cursor)) + '</span></div>' +
      '<div class="ln drill-feedback' + (s.solved ? ' drill-correct' : '') + '">' + esc(this.feedback || 'enter=check') + '</div></div>';
  }
}
class MathDrillMenu extends MenuScreen {
  constructor(app) {
    super(app, [{ title: 'MATH DRILL', items: TI.mathDrill.MODES.map(o => ({ id: o.id, label: o.label })) }],
      it => app.push(new MathDrillScreen(app, it.id)), { title: 'MATH DRILL' });
    this.isMathDrill = true;
  }
  key(a) {
    if (GLOBAL_KEYS.has(a) && !DRILL_EXIT_KEYS.has(a)) return true;
    return super.key(a);
  }
}
function mathDrillMenu(app) {
  while (app.stack.length > 1 && app.top.isMathDrill) app.pop();
  app.push(new MathDrillMenu(app));
}

// ---------------------------------------------------------------- mode screen
const MODE_ROWS = [
  { key: 'angle', opts: [['DEG', 'DEG'], ['RAD', 'RAD'], ['GRAD', 'GRAD']] },
  { key: 'notation', opts: [['NORM', 'NORM'], ['SCI', 'SCI'], ['ENG', 'ENG']] },
  { key: 'fix', tight: true, opts: [['FLOAT', null]].concat('0123456789'.split('').map(d => [d, +d])) },
  { key: 'cplx', opts: [['REAL', 'REAL'], ['a+b<i>i</i>', 'RECT'], ['r∠θ', 'POLAR']] },
  { key: 'base', opts: [['DEC', 'DEC'], ['HEX', 'HEX'], ['BIN', 'BIN'], ['OCT', 'OCT']] },
  { key: 'mathprint', opts: [['CLASSIC', false], ['MATHPRINT', true]] },
];
function modeScreen(app) {
  const st = app.state.settings;
  const rows = MODE_ROWS.map(m => ({
    type: 'choice', label: '', tight: m.tight, opts: m.opts.map(o => o[0]),
    get: () => m.opts.findIndex(o => o[1] === st[m.key]),
    set: k => { st[m.key] = m.opts[k][1]; app.save(); },
  }));
  rows.push({ type: 'action', label: 'Math Drill', run: () => { app.pop(); mathDrillMenu(app); } });
  const f = new FormScreen(app, { rows, lines: 4, key: a => {
    if (a === 'mode') { app.pop(); return true; }
    if (a === '7') { app.pop(); mathDrillMenu(app); return true; }
    if (a === 'up' || a === 'down') {
      const moved = f.move(a === 'up' ? -1 : 1);
      if (moved && f.row.type === 'choice') f.row.cur = f.row.get();
      return true;
    }
    return false;
  } });
  app.push(f);
}

// ======================================================================= app
class App {
  constructor(el) {
    this.el = el;
    this.state = loadState() || freshState();
    this.stack = [new Home(this)];
    this.second = false;
    this.on = true;
    this.tap = null;
    this.keepTap = false;
  }
  get top() { return this.stack[this.stack.length - 1]; }
  push(s) { this.stack.push(s); }
  pop() { if (this.stack.length > 1) this.stack.pop(); }
  home() { this.stack = [this.stack[0]]; }
  save() { saveState(this.state); }
  press(id) {
    const k = KEYMAP[id];
    if (!k) return;
    if (id === 'second') { if (this.on) this.second = !this.second; this.render(); return; }
    const a = this.second && k.act2 ? k.act2 : k.act;
    this.second = false;
    this.dispatch(a);
  }
  dispatch(a) {
    if (!this.on) { if (a === 'on') { this.on = true; this.render(); } return; }
    this.keepTap = false;
    try {
      if (!this.top.isMathDrill && this.state.settings.base !== 'DEC' && DEC_ONLY.has(a)) throw new CalcError('CHANGE MODE to DEC');
      const handled = this.top.key(a);
      if (!handled) this.global(a);
    } catch (e) {
      if (e instanceof CalcError) this.push(new ErrScreen(this, e.type));
      else { console.error(e); this.push(new ErrScreen(this, 'SYNTAX')); }
    }
    if (!this.keepTap) this.tap = null;
    this.render();
  }
  global(a) {
    switch (a) {
      case 'quit': this.home(); return;
      case 'mode': modeScreen(this); return;
      case 'off': this.on = false; this.second = false; this.home(); this.save(); return;
      case 'contrastUp': this.state.contrast = Math.min(4, this.state.contrast + 1); this.save(); return;
      case 'contrastDown': this.state.contrast = Math.max(-4, this.state.contrast - 1); this.save(); return;
      case 'reset': yesNo(this, 'RESET', false, () => {
        const contrast = this.state.contrast;
        this.state = freshState(); this.state.contrast = contrast;
        this.stack = [new Home(this)];
        this.save();
        this.push(new MsgScreen(this, ['', 'Memory cleared']));
      }); return;
      case 'clearvar': yesNo(this, 'CLEAR VAR', true, () => { this.state.vars = {}; this.state.varApprox = {}; this.save(); }); return;
      case 'recall': if (this.target()) recallMenu(this); return;
      case 'math': if (this.target()) mathMenu(this); return;
      case 'complex': if (this.target()) complexMenu(this); return;
      case 'random': if (this.target()) randomMenu(this); return;
      case 'constants': if (this.target()) constantsMenu(this); return;
      case 'convert': if (this.target()) convertMenu(this); return;
      case 'basen': if (this.target()) baseMenu(this); return;
      case 'matrix': this.ensureTarget(); matrixMenu(this); return;
      case 'vector': this.ensureTarget(); vectorMenu(this); return;
      case 'statreg': this.ensureTarget(); statMenu(this); return;
      case 'table': this.ensureTarget(); tableMenu(this); return;
      case 'data': this.home(); dataEditor(this); return;
      case 'numsolv': this.home(); numSolv(this); return;
      case 'polysolv': this.home(); polyMenu(this); return;
      case 'syssolv': this.home(); sysMenu(this); return;
      case 'setop': this.home(); setOp(this); return;
      case 'expreval': {
        const initial = this.top instanceof Home ? clone(this.top.ed.items()) : null;
        this.home(); exprEval(this, initial); return;
      }
    }
  }
  target() { return this.top.editor ? this.top.editor() : null; }
  ensureTarget() { if (!this.target()) this.home(); }

  render() {
    const lcd = this.el.querySelector('.lcd');
    const screen = lcd.querySelector('.screen');
    lcd.classList.toggle('off', !this.on);
    lcd.style.setProperty('--contrast', String(this.state.contrast));
    const secondKey = this.el.querySelector('[data-k="second"]');
    if (secondKey) {
      secondKey.setAttribute('aria-pressed', String(this.second));
      secondKey.classList.toggle('is-second', this.second);
    }
    if (!this.on) { screen.innerHTML = ''; lcd.querySelector('.status').innerHTML = ''; return; }
    const st = this.state.settings, top = this.top;
    const ind = [];
    if (this.second) ind.push('<span class="ind sec">2ND</span>');
    if (top.isMathDrill) ind.push('<span class="ind">DRILL</span>');
    else {
      ind.push('<span class="ind">' + st.angle + '</span>');
      if (st.fix != null) ind.push('<span class="ind">FIX</span>');
      if (st.notation !== 'NORM') ind.push('<span class="ind">' + st.notation + '</span>');
      if (st.base !== 'DEC') ind.push('<span class="ind">' + st.base[0] + '</span>');
      if (!st.mathprint) ind.push('<span class="ind">CLASSIC</span>');
    }
    if (top instanceof Home && top.scrollable()) ind.push('<span class="ind arr">▲</span>');
    lcd.querySelector('.status').innerHTML = ind.join('');
    screen.innerHTML = top.html();
    screen.className = 'screen ' + (top instanceof Home ? 'is-home' : 'is-app');
    // keep the cursor or selection in view
    const hist = screen.querySelector('.hist');
    if (hist) {
      const sel = hist.querySelector('.sel');
      if (sel) hist.scrollTop = Math.max(0, sel.offsetTop - hist.clientHeight / 2);
      else hist.scrollTop = hist.scrollHeight;
    }
    screen.querySelectorAll('.entry, .ff, .gb, .eqn, .sys').forEach(line => {
      const c = line.querySelector('.cur, .cur-end, .cur-ins');
      if (!c) return;
      const lr = line.getBoundingClientRect(), cr = c.getBoundingClientRect();
      if (cr.right > lr.right - 4) line.scrollLeft += cr.right - lr.right + 12;
      if (cr.left < lr.left + 4) line.scrollLeft -= lr.left - cr.left + 12;
    });
  }
}

// ======================================================================= keypad
// Each key: id, main label, 2nd label, style, primary action, 2nd action.
const KEYS = [
  ['second', '2nd', '', 'k2nd', 'second'],
  ['mode', 'mode', 'quit', 'kfn', 'mode', 'quit'],
  ['delete', 'delete', 'insert', 'kfn', 'delete', 'insert'],
  ['lnlog', 'ln log', '<i>d</i>/<i>dx</i><span class="bx"></span>', 'kfn', 'lnlog', 'deriv'],
  ['math', 'math', 'matrix', 'kfn', 'math', 'matrix'],
  ['data', 'data', 'stat-reg/distr', 'kfn', 'data', 'statreg'],
  ['exp', 'e<sup><span class="bx"></span></sup>&thinsp;10<sup><span class="bx"></span></sup>', '∫<span class="lims"><span class="bx"></span><span class="bx"></span></span><span class="bx"></span><i>dx</i>', 'kfn', 'exp', 'integ'],
  ['EE', 'EE', 'vector', 'kfn', 'EE', 'vector'],
  ['prb', '<span class="kbig">!</span> <span class="kstack"><span>nCr</span><span>nPr</span></span>', 'random', 'kfn', 'prb', 'random'],
  ['table', 'table', 'expr-eval', 'kfn', 'table', 'expreval'],
  ['clear', 'clear', '', 'kfn', 'clear'],
  ['pi', '<i class="kpi">π</i><span class="kstack"><i>e</i><i>i</i></span>', 'complex', 'kfn', 'pi', 'complex'],
  ['sin', '<span class="kstack ktrig"><span>sin</span><span>sin<sup>−1</sup></span></span>', 'num-solv', 'kfn', 'sin', 'numsolv'],
  ['cos', '<span class="kstack ktrig"><span>cos</span><span>cos<sup>−1</sup></span></span>', 'poly-solv', 'kfn', 'cos', 'polysolv'],
  ['tan', '<span class="kstack ktrig"><span>tan</span><span>tan<sup>−1</sup></span></span>', 'sys-solv', 'kfn', 'tan', 'syssolv'],
  ['div', '÷', '%', 'kop', 'div', 'percent'],
  ['pow', '<i>x</i><sup><span class="bx"></span></sup>', '<span class="root kroot"><span class="idx"><span class="bx"></span></span>' + R.radicalHtml('<span class="bx"></span>') + '</span>', 'kfn', 'pow', 'nroot'],
  ['frac', '<span class="kfrac"><span><span class="bx"></span></span><span><span class="bx"></span></span></span>', '<span class="kfrac sm"><span>1</span><span><span class="bx"></span></span></span>', 'kfn', 'frac', 'recip'],
  ['lparen', '(', 'constants', 'kfn', 'lparen', 'constants'],
  ['rparen', ')', 'op', 'kfn', 'rparen', 'op'],
  ['mul', '×', 'set op', 'kop', 'mul', 'setop'],
  ['sq', '<i>x</i><sup>2</sup>', '<span class="kroot">' + R.radicalHtml('<span class="bx"></span>') + '</span>', 'kfn', 'sq', 'sqrt'],
  ['7', '7', '<span class="bx"></span><span class="kfrac sm"><span><span class="bx"></span></span><span><span class="bx"></span></span></span>', 'knum', '7', 'mixed'],
  ['8', '8', 'convert', 'knum', '8', 'convert'],
  ['9', '9', 'base n', 'knum', '9', 'basen'],
  ['sub', '−', '◂◐', 'kop', 'sub', 'contrastDown'],
  ['var', '<i>x</i><span class="kvar"><i>yzt</i><i>abcd</i></span>', 'clear var', 'kfn', 'var', 'clearvar'],
  ['4', '4', 'D', 'knum', '4', 'hexD'],
  ['5', '5', 'E', 'knum', '5', 'hexE'],
  ['6', '6', 'F', 'knum', '6', 'hexF'],
  ['add', '+', '◐▸', 'kop', 'add', 'contrastUp'],
  ['sto', 'sto→', 'recall', 'kfn', 'sto', 'recall'],
  ['1', '1', 'A', 'knum', '1', 'hexA'],
  ['2', '2', 'B', 'knum', '2', 'hexB'],
  ['3', '3', 'C', 'knum', '3', 'hexC'],
  ['toggle', '◂▸≈', 'f◂▸d', 'kop', 'toggle', 'fd'],
  ['on', 'on', 'off', 'kfn', 'on', 'off'],
  ['0', '0', 'reset', 'knum', '0', 'reset'],
  ['.', '.', ',', 'knum', '.', 'comma'],
  ['neg', '(−)', 'answer', 'knum', 'neg', 'ans'],
  ['enter', 'enter', '', 'kop', 'enter'],
];
const KEYMAP = {};
KEYS.forEach(([id, main, sec, cls, act, act2]) => { KEYMAP[id] = { id, main, sec, cls, act, act2 }; });
['up', 'down', 'left', 'right'].forEach(d => {
  KEYMAP[d] = { id: d, act: d, act2: { up: 'histUp', down: 'histDown', left: 'lhome', right: 'lend' }[d] };
});
const ARIA = {
  second: '2nd, second function', mode: 'mode; second: quit', delete: 'delete; second: insert', lnlog: 'natural log and log; second: derivative', math: 'math; second: matrix', data: 'data; second: statistics and distributions',
  exp: 'e to the power and 10 to the power; second: integral', EE: 'EE exponent; second: vector', prb: 'factorial, nCr, nPr; second: random number', table: 'table; second: expression evaluation', clear: 'clear',
  pi: 'pi, e, and imaginary unit i; second: complex menu', sin: 'sine; second: numerical solver', cos: 'cosine; second: polynomial solver', tan: 'tangent; second: system solver', div: 'divide; second: percent', pow: 'power; second: nth root', frac: 'fraction; second: reciprocal',
  lparen: 'left parenthesis; second: constants', rparen: 'right parenthesis; second: operation', mul: 'multiply; second: set operation', sq: 'square; second: square root', sub: 'subtract; second: decrease contrast',
  var: 'variables x, y, z, t, a, b, c, d; second: clear variables', add: 'add; second: increase contrast', sto: 'store; second: recall', toggle: 'toggle answer; second: fraction to decimal', on: 'on; second: off', neg: 'negative sign; second: answer',
  enter: 'enter', '.': 'decimal point; second: comma',
  '0': 'zero; second: reset', '1': 'one; second: hexadecimal A', '2': 'two; second: hexadecimal B', '3': 'three; second: hexadecimal C',
  '4': 'four; second: hexadecimal D', '5': 'five; second: hexadecimal E', '6': 'six; second: hexadecimal F',
  '7': 'seven; second: mixed number', '8': 'eight; second: unit conversion', '9': 'nine; second: base conversion',
  up: 'up arrow; second: history up', down: 'down arrow; second: history down', left: 'left arrow; second: home', right: 'right arrow; second: end',
};

function buildKeypad(app, root) {
  const pad = root.querySelector('.keys');
  let h = '';
  const keyHtml = id => {
    const k = KEYMAP[id];
    return '<div class="kcell' + (k.sec ? '' : ' nosec') + '"><span class="sec">' + (k.sec || '&nbsp;') + '</span>' +
      '<button type="button" class="key ' + k.cls + '" data-k="' + id + '" aria-label="' + esc(ARIA[id] || id) + '"' + (id === 'second' ? ' aria-pressed="false"' : '') + '>' + k.main + '</button></div>';
  };
  const rows = [
    ['second', 'mode', 'delete', 'DPAD'],
    ['lnlog', 'math', 'data'],
    ['exp', 'EE', 'prb', 'table', 'clear'],
    ['pi', 'sin', 'cos', 'tan', 'div'],
    ['pow', 'frac', 'lparen', 'rparen', 'mul'],
    ['sq', '7', '8', '9', 'sub'],
    ['var', '4', '5', '6', 'add'],
    ['sto', '1', '2', '3', 'toggle'],
    ['on', '0', '.', 'neg', 'enter'],
  ];
  rows.forEach(r => r.forEach(id => {
    if (id === 'DPAD') {
      h += '<div class="dpad" role="group" aria-label="arrow keys">' +
        ['up', 'left', 'right', 'down'].map(d => '<button type="button" class="dk ' + d + '" data-k="' + d + '" aria-label="' + esc(ARIA[d]) + '"></button>').join('') +
        '<span class="dcenter"></span></div>';
    } else h += keyHtml(id);
  }));
  pad.innerHTML = h;
  let pointerKey = null;
  pad.addEventListener('pointerdown', e => {
    const b = e.target.closest('[data-k]');
    if (!b || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    app.el.focus({ preventScroll: true });
    b.classList.add('is-pressed');
    pointerKey = b;
    app.press(b.dataset.k);
  });
  pad.addEventListener('click', e => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    if (pointerKey === b && e.detail !== 0) { pointerKey = null; return; }
    pointerKey = null;
    app.press(b.dataset.k);
  });
  const up = () => pad.querySelectorAll('.is-pressed').forEach(b => b.classList.remove('is-pressed'));
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointerleave', up);
  pad.addEventListener('pointercancel', up);
}

// Physical keyboard shortcuts: key -> on-screen key id (KB) or direct action (KB_ACT).
const KB = {
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '.': '.',
  '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '^': 'pow', '(': 'lparen', ')': 'rparen',
  'Enter': 'enter', '=': 'enter', 'Backspace': 'delete', 'Delete': 'delete', 'Escape': 'clear',
  'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right',
  'x': 'var', 'p': 'pi', 's': 'sin', 'c': 'cos', 't': 'tan', 'l': 'lnlog', 'e': 'exp', '!': 'prb',
  'm': 'math', 'd': 'data', 'n': 'neg', 'f': 'frac', 'q': 'sq', 'E': 'EE', 'o': 'mode', 'a': 'toggle', '>': 'sto', '`': 'second',
};
const KB_SECOND = { ',': '.', '%': 'div', 'r': 'sq', 'Home': 'left', 'End': 'right' };
function bindKeyboard(app) {
  const onKeyDown = e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const keypadFocus = t && t.dataset && t.dataset.k;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|SUMMARY|A)$/.test(t.tagName || '') || ((t.tagName === 'BUTTON' && !keypadFocus) || (t.getAttribute && (t.getAttribute('contenteditable') === 'true' || t.getAttribute('role') === 'textbox'))))) return;
    if (KB_SECOND[e.key]) {
      e.preventDefault();
      // Use the same physical-key path so a recording can be followed exactly.
      if (!app.second) app.press('second');
      app.press(KB_SECOND[e.key]);
      flash(app, KB_SECOND[e.key]);
      return;
    }
    const id = KB[e.key];
    if (!id) return;
    if ((e.key === 'Enter' || e.key === ' ') && t && t.dataset && t.dataset.k) return;
    e.preventDefault();
    app.press(id);
    flash(app, id);
  };
  app.el.addEventListener('keydown', onKeyDown);
  return () => app.el.removeEventListener('keydown', onKeyDown);
}
function flash(app, id) {
  if (!id) return;
  const b = app.el.querySelector('[data-k="' + CSS.escape(id) + '"]');
  if (!b) return;
  b.classList.add('is-pressed');
  setTimeout(() => b.classList.remove('is-pressed'), 110);
}

function start(root) {
  const app = new App(root);
  buildKeypad(app, root);
  const unbindKeyboard = bindKeyboard(app);
  app.render();
  const blinkTimer = setInterval(() => { const c = root.querySelector('.lcd'); if (c) c.classList.toggle('blink'); }, 520);
  app.destroy = () => { unbindKeyboard(); clearInterval(blinkTimer); if (TI.app === app) delete TI.app; };
  TI.app = app;
  return app;
}

TI.start = start;
TI.App = App;
})(calculatorScope);

// Upstream source: display-copy.js
/* Copies the visible LCD without external libraries, fonts, or image assets. */
(function (G) {
'use strict';
const TI = G.TI = G.TI || {};
const intersects = (a, b) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
const transparent = c => !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)';

// Paint the current DOM geometry onto a canvas. This keeps MathPrint fractions,
// roots, exponents, and clipping intact; flattening innerText loses that layout.
function capturePNG(lcd) {
  try {
    const doc = lcd.ownerDocument, view = doc.defaultView || G;
    const box = lcd.getBoundingClientRect();
    if (!box.width || !box.height) throw new Error('Display is not visible');
    const canvas = doc.createElement('canvas'), ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    const scale = Math.min(3, Math.max(2, view.devicePixelRatio || 1));
    canvas.width = Math.ceil(box.width * scale); canvas.height = Math.ceil(box.height * scale);
    ctx.scale(scale, scale); ctx.translate(-box.left, -box.top);
    const rootStyle = view.getComputedStyle(lcd);
    ctx.beginPath();
    const radii = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map(c => parseFloat(rootStyle['border' + c + 'Radius']) || 0);
    if (ctx.roundRect) ctx.roundRect(box.left, box.top, box.width, box.height, radii);
    else ctx.rect(box.left, box.top, box.width, box.height);
    ctx.clip();
    const colors = rootStyle.backgroundImage.match(/rgba?\([^)]*\)|#[\da-f]+/gi);
    if (colors && colors.length > 1) {
      const gradient = ctx.createLinearGradient(box.left, box.top, box.right, box.bottom);
      colors.forEach((c, i) => gradient.addColorStop(i / (colors.length - 1), c));
      ctx.fillStyle = gradient;
    } else ctx.fillStyle = transparent(rootStyle.backgroundColor) ? '#b8cca8' : rootStyle.backgroundColor;
    ctx.fillRect(box.left, box.top, box.width, box.height);

    function paintText(node, clip) {
      const style = view.getComputedStyle(node.parentElement);
      if (style.visibility === 'hidden') return;
      ctx.fillStyle = style.color;
      ctx.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
      ctx.textBaseline = 'alphabetic';
      const range = doc.createRange();
      let offset = 0;
      for (const ch of node.textContent) {
        range.setStart(node, offset); offset += ch.length; range.setEnd(node, offset);
        const r = range.getBoundingClientRect();
        if (!ch.trim() || !intersects(r, clip)) continue;
        const m = ctx.measureText(ch), size = parseFloat(style.fontSize);
        const ascent = m.fontBoundingBoxAscent == null ? size * .8 : m.fontBoundingBoxAscent;
        const descent = m.fontBoundingBoxDescent == null ? size * .2 : m.fontBoundingBoxDescent;
        ctx.fillText(ch, r.left, r.top + (r.height - ascent - descent) / 2 + ascent);
      }
      range.detach();
    }
    function paint(el, clip) {
      if (el.nodeType === 3) { paintText(el, clip); return; }
      if (el.nodeType !== 1 || el.matches('.cur-end, .cur-ins')) return;
      const style = view.getComputedStyle(el), r = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || !intersects(r, clip)) return;
      ctx.save();
      if (!transparent(style.backgroundColor) && !el.matches('.cur')) {
        ctx.fillStyle = style.backgroundColor; ctx.fillRect(r.left, r.top, r.width, r.height);
      }
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const w = parseFloat(style['border' + side + 'Width']);
        if (!w || style['border' + side + 'Style'] === 'none') continue;
        ctx.fillStyle = style['border' + side + 'Color'];
        if (side === 'Top') ctx.fillRect(r.left, r.top, r.width, w);
        if (side === 'Bottom') ctx.fillRect(r.left, r.bottom - w, r.width, w);
        if (side === 'Left') ctx.fillRect(r.left, r.top, w, r.height);
        if (side === 'Right') ctx.fillRect(r.right - w, r.top, w, r.height);
      }
      if (el.matches('.sqrt > .rs > svg')) {
        const stroke = view.getComputedStyle(el.querySelector('path'));
        ctx.strokeStyle = stroke.stroke; ctx.lineWidth = parseFloat(stroke.strokeWidth);
        ctx.lineCap = 'square'; ctx.lineJoin = 'miter'; ctx.beginPath();
        TI.render.radicalPoints.forEach(([x, y], i) => {
          const px = r.left + r.width * x / 100, py = r.top + r.height * y / 100;
          if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        });
        ctx.stroke(); ctx.restore(); return;
      }
      const clipsX = /^(hidden|clip|auto|scroll)$/.test(style.overflowX);
      const clipsY = /^(hidden|clip|auto|scroll)$/.test(style.overflowY);
      const next = {
        left: clipsX ? Math.max(clip.left, r.left) : clip.left,
        right: clipsX ? Math.min(clip.right, r.right) : clip.right,
        top: clipsY ? Math.max(clip.top, r.top) : clip.top,
        bottom: clipsY ? Math.min(clip.bottom, r.bottom) : clip.bottom,
      };
      ctx.beginPath(); ctx.rect(next.left, next.top, Math.max(0, next.right - next.left), Math.max(0, next.bottom - next.top)); ctx.clip();
      el.childNodes.forEach(child => paint(child, next));
      ctx.restore();
    }
    lcd.childNodes.forEach(child => paint(child, box));
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png'));
  } catch (e) { return Promise.reject(e); }
}

function displayText(lcd) {
  const screen = lcd.querySelector('.screen'), box = screen.getBoundingClientRect();
  function text(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.matches('.cur-end, .cur-ins')) return '';
    if (node.matches('.frac')) return '(' + text(node.querySelector('.num')) + ')/(' + text(node.querySelector('.den')) + ')';
    if (node.matches('.sup')) return '^(' + Array.from(node.childNodes, text).join('') + ')';
    return Array.from(node.childNodes, text).join('');
  }
  const lines = Array.from(screen.querySelectorAll('.ln')).filter(el => intersects(el.getBoundingClientRect(), box)).map(el => text(el).trim());
  return [lcd.querySelector('.status').innerText.trim(), ...(lines.length ? lines : [screen.innerText.trim()])].filter(Boolean).join('\n');
}

class DisplayCopy {
  constructor(app) {
    this.app = app; this.root = app.el; this.lcd = this.root.querySelector('.lcd');
    this.status = this.root.querySelector('.display-copy-status');
    this.fallback = this.root.querySelector('.display-copy-fallback');
    this.field = this.root.querySelector('.display-copy-text');
    this.busy = false; this.image = null; this.text = '';
    this.lcd.addEventListener('click', () => {
      this.copy();
      // Keep calculator typing usable immediately after a pointer copy.
      this.root.focus({ preventScroll: true });
    });
    this.lcd.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); e.stopPropagation(); this.copy();
    });
    this.root.querySelector('[data-display-copy="save"]').addEventListener('click', () => this.save());
    this.root.querySelector('[data-display-copy="text"]').addEventListener('click', () => this.copyText());
  }
  message(s) { this.status.textContent = s; }
  async copy() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Freeze the screen during the click, before asynchronous PNG encoding.
      this.text = displayText(this.lcd); this.field.value = this.text;
      this.image = capturePNG(this.lcd); this.image.catch(() => {});
      this.message('Copying screen…');
      if (!G.navigator || !G.navigator.clipboard || !G.navigator.clipboard.write || !G.ClipboardItem) throw new Error('Clipboard unavailable');
      // Do not await encoding before write: Safari requires the click activation.
      await G.navigator.clipboard.write([new G.ClipboardItem({ 'image/png': this.image })]);
      this.fallback.hidden = true; this.message('Calculator screen copied as an image.');
    } catch (_) {
      this.fallback.hidden = false;
      this.message('Screen copying is unavailable or blocked. Save PNG, or copy the screen text below.');
    } finally { this.busy = false; }
  }
  async save() {
    let url;
    try {
      const blob = await this.image, doc = this.lcd.ownerDocument;
      if (!blob) throw new Error('No captured screen');
      url = G.URL.createObjectURL(blob);
      const link = doc.createElement('a'); link.href = url; link.download = 'ti36x-screen.png';
      doc.body.appendChild(link); link.click(); link.remove();
      this.message('Screen PNG download requested.');
    } catch (_) { this.message('PNG export is unavailable. Copy the screen text below.'); }
    finally { if (url) G.setTimeout(() => G.URL.revokeObjectURL(url), 10000); }
  }
  async copyText() {
    try {
      if (!G.navigator || !G.navigator.clipboard || !G.navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await G.navigator.clipboard.writeText(this.text); this.message('Screen text copied.');
    } catch (_) {
      this.message('Select and copy the screen text below.'); this.field.focus(); this.field.select();
    }
  }
}
TI.displayCopy = { DisplayCopy, capturePNG, displayText };
TI.startDisplayCopy = app => (app.displayCopy = new DisplayCopy(app));
})(calculatorScope);

// Upstream source: recorder.js
/* Optional, transient recording as key pictures in press order. */
(function (G) {
'use strict';
const TI = G.TI = G.TI || {};
const LABELS = Object.freeze({
  second: '2nd', mode: 'mode', delete: 'delete', lnlog: 'ln log', math: 'math', data: 'data',
  exp: 'eˣ / 10ˣ', EE: 'EE', prb: '! / nCr / nPr', table: 'table', clear: 'clear',
  pi: 'π / e / i', sin: 'sin', cos: 'cos', tan: 'tan', div: '÷', pow: 'xʸ', frac: 'n/d',
  lparen: '(', rparen: ')', mul: '×', sq: 'x²', sub: '−', var: 'x y z t a b c d',
  add: '+', sto: 'sto→', toggle: '◂▸≈', on: 'on', '.': '.', neg: '(−)', enter: 'enter',
  up: '↑', down: '↓', left: '←', right: '→',
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
});
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function keySequence(id) {
  return Object.prototype.hasOwnProperty.call(LABELS, id) ? [LABELS[id]] : [];
}
function serialize(session) {
  return session.steps.map(step => '[' + step.keys.join(' → ') + ']').join(' ⇒ ');
}
const DIRECTIONS = Object.freeze({
  up: { name: 'Up', triangle: 'M28 6 L23 12 L33 12 Z', box: 'x="19" y="2" width="18" height="14"' },
  down: { name: 'Down', triangle: 'M28 36 L23 30 L33 30 Z', box: 'x="19" y="26" width="18" height="14"' },
  left: { name: 'Left', triangle: 'M6 21 L12 16 L12 26 Z', box: 'x="2" y="12" width="14" height="18"' },
  right: { name: 'Right', triangle: 'M50 21 L44 16 L44 26 Z', box: 'x="40" y="12" width="14" height="18"' },
});
function keyPicture(app, step) {
  const direction = DIRECTIONS[step.id];
  const label = direction ? direction.name + ' arrow key' : step.keys.join(' then ') + ' key';
  let face;
  if (direction) {
    // Recreate the calculator's own pad, lighting only the direction pressed.
    face = '<span class="recorder-dpad" aria-hidden="true"><svg viewBox="0 0 56 42"><rect ' + direction.box + ' rx="6" fill="#0092AC"/>' +
      Object.entries(DIRECTIONS).map(([id, d]) => '<path d="' + d.triangle + '" fill="#FFFFFF" opacity="' + (id === step.id ? '1' : '.22') + '"/>').join('') +
      '<circle cx="28" cy="21" r="5" fill="#004A6E" stroke="#0A3F59"/></svg></span>';
  } else {
    const button = app.el && app.el.querySelector('[data-k="' + step.id + '"]');
    const style = button && String(button.className).split(/\s+/).find(c => ['kfn', 'knum', 'kop', 'k2nd'].includes(c)) || 'kfn';
    // Reuse our keypad lettering, without making the recorded picture a button.
    face = '<span class="key ' + style + '" aria-hidden="true">' + (button && button.innerHTML || escape(step.keys.join(' → '))) + '</span>';
  }
  return '<span class="recorder-key" role="img" aria-label="' + escape(label) + '" data-recorded-key="' + escape(step.id) + '">' + face + '</span>';
}
class Recorder {
  constructor(app, root, toggleButton = app.el && app.el.querySelector('.solar')) {
    this.app = app; this.root = root; this.toggleButton = toggleButton;
    this.page = app.el && app.el.closest && app.el.closest('.page');
    this.recording = false; this.steps = []; this.status = ''; this.fallback = false; this.imageFallback = false;
    if (this.toggleButton) this.toggleButton.addEventListener('click', () => this.toggle());
    // Record only actual physical-key calls; keyboard shortcuts use this same path.
    let depth = 0;
    const self = this, press = app.press;
    app.press = function (id) {
      const outer = depth === 0, active = self.recording;
      depth++;
      try { return press.apply(this, arguments); }
      finally { depth--; if (outer && active) self.safeCapture(keySequence(id), id); }
    };
    this.render();
  }
  get count() { return this.steps.length; }
  snapshot() { return JSON.parse(JSON.stringify({ steps: this.steps })); }
  toggle() {
    this.recording = !this.recording; this.status = ''; this.fallback = false; this.render();
    if (this.app.el && this.app.el.focus) this.app.el.focus({ preventScroll: true });
  }
  safeCapture(keys, id) {
    try { this.capture(keys, id); }
    catch (_) { this.recording = false; this.status = 'Recording stopped because the list could not update. Calculator input continues normally.'; }
  }
  capture(keys, id) {
    if (!keys.length) return;
    this.steps.push({ id, keys: keys.slice() }); this.status = '';
    this.render(true);
  }
  clear() {
    this.steps = []; this.fallback = false; this.imageFallback = false; this.status = 'Button press list cleared.'; this.render();
    if (this.recording && this.app.el && this.app.el.focus) this.app.el.focus({ preventScroll: true });
  }
  render(scroll) {
    if (this.toggleButton) {
      const label = this.recording ? 'Hide button presses' : 'Show button presses';
      this.toggleButton.setAttribute('aria-pressed', String(this.recording));
      this.toggleButton.setAttribute('aria-expanded', String(this.recording));
      this.toggleButton.setAttribute('aria-label', label);
      this.toggleButton.setAttribute('title', label);
    }
    if (this.page) this.page.classList.toggle('is-recording', this.recording);
    if (!this.root) return;
    this.root.hidden = !this.recording;
    const focusRoot = this.root.getRootNode();
    const active = focusRoot && focusRoot.activeElement;
    const controls = ['[data-recorder="text"]', '[data-recorder="image"]', '[data-recorder="save"]', '[data-recorder="clear"]', '.recorder-text'];
    const focused = active ? controls.find(selector => this.root.querySelector(selector) === active) : null;
    const visible = this.recording;
    const rows = this.steps.map((step, i) => '<li' + (i === this.count - 1 ? ' class="is-latest"' : '') + '>' + (i ? '<span class="recorder-next" aria-hidden="true">⇒</span>' : '') + keyPicture(this.app, step) + '</li>').join('');
    this.root.innerHTML = '<div class="recorder-heading"><h2>Button presses</h2></div>' +
      '<div class="recorder-content"><ul class="recorder-steps" aria-label="Button presses in order">' + rows + '</ul>' +
      '<p class="recorder-empty"' + (this.count ? ' hidden' : '') + '>Press a calculator key to add it to the list.</p>' +
      '<div class="recorder-actions"><button type="button" data-recorder="text"' + (!this.count ? ' disabled' : '') + '>Copy text</button><button type="button" data-recorder="image"' + (!this.count ? ' disabled' : '') + '>Copy image</button><button type="button" data-recorder="save"' + (!this.imageFallback ? ' hidden' : '') + (!this.count ? ' disabled' : '') + '>Save PNG</button><button type="button" data-recorder="clear">Clear recording</button></div><textarea class="recorder-text" aria-label="Button presses to select and copy" readonly' + (!this.fallback ? ' hidden' : '') + '>' + escape(serialize(this.snapshot())) + '</textarea></div>' +
      '<p class="recorder-status" role="status"' + (!this.status ? ' hidden' : '') + '>' + escape(this.status) + '</p>';
    this.root.querySelector('[data-recorder="text"]').addEventListener('click', () => this.copyText());
    this.root.querySelector('[data-recorder="image"]').addEventListener('click', () => this.copyImage());
    this.root.querySelector('[data-recorder="save"]').addEventListener('click', () => this.saveImage());
    this.root.querySelector('[data-recorder="clear"]').addEventListener('click', () => this.clear());
    const list = this.root.querySelector('.recorder-steps');
    if (scroll) list.scrollTop = list.scrollHeight;
    if (focused) {
      const focusable = visible && (!['[data-recorder="text"]', '[data-recorder="image"]', '[data-recorder="save"]'].includes(focused) || this.count) && (focused !== '[data-recorder="save"]' || this.imageFallback) && (focused !== '.recorder-text' || this.fallback);
      const target = focusable ? this.root.querySelector(focused) : this.toggleButton;
      if (target) target.focus({ preventScroll: true });
    }
  }
  async copyText() {
    if (!this.count) return;
    const text = serialize(this.snapshot());
    try {
      if (!G.navigator || !G.navigator.clipboard || !G.navigator.clipboard.writeText) throw new Error('unavailable');
      await G.navigator.clipboard.writeText(text); this.status = 'Button presses copied.'; this.fallback = false;
    } catch (_) { this.status = 'Text clipboard unavailable or permission denied. Select and copy the button presses below.'; this.fallback = true; }
    this.render();
    if (this.fallback && this.root) { const field = this.root.querySelector('.recorder-text'); field.focus(); field.select(); }
  }
  async copyImage() {
    if (!this.count) return;
    let png;
    try {
      if (!G.navigator || !G.navigator.clipboard || !G.navigator.clipboard.write || !G.ClipboardItem) throw new Error('clipboard unavailable');
      png = createSequencePNG(this.snapshot());
      // Keep click activation: pass the encoding promise directly to ClipboardItem.
      png.catch(() => {});
      await G.navigator.clipboard.write([new G.ClipboardItem({ 'image/png': png })]);
      this.status = 'Button press image copied.'; this.imageFallback = false;
    } catch (error) {
      let exportError;
      if (png) { try { await png; } catch (e) { exportError = e; } }
      this.imageFallback = !exportError;
      this.status = exportError ? exportError.message + ' Use Copy text.' : 'Image clipboard unavailable or permission denied. Use Save PNG or Copy text.';
    }
    this.render();
  }
  async saveImage() {
    if (!this.count) return;
    let url;
    try {
      const blob = await createSequencePNG(this.snapshot());
      url = G.URL.createObjectURL(blob);
      const link = G.document.createElement('a'); link.href = url; link.download = 'ti36x-button-presses.png';
      G.document.body.appendChild(link); link.click(); link.remove();
      this.status = 'PNG download requested.';
    } catch (error) { this.status = 'PNG could not be saved. ' + error.message + ' Use Copy text.'; }
    finally { if (url) G.setTimeout(() => G.URL.revokeObjectURL(url), 10000); }
    this.render();
  }

}
// Native canvas keeps file/localhost exports origin-clean and independent of page CSS.
function sequenceLayout(session) {
  const columns = 7, rows = Math.ceil(session.steps.length / columns), height = Math.max(118, rows * 78 + 64);
  if (height > 16000) throw new Error('This sequence is too large for one PNG.');
  return { width: 960, height, keys: session.steps.map((step, i) => ({ step, x: 32 + (i % columns) * 128, y: 32 + Math.floor(i / columns) * 78, arrow: i > 0 })) };
}
function rounded(ctx, x, y, w, h, radius) {
  ctx.beginPath(); ctx.moveTo(x + radius, y); ctx.lineTo(x + w - radius, y); ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius); ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius); ctx.quadraticCurveTo(x, y, x + radius, y); ctx.closePath(); ctx.fill(); ctx.stroke();
}
function drawKey(ctx, step, x, y) {
  const id = step.id, direction = DIRECTIONS[id], numeric = /^[0-9]$/.test(id) || id === '.' || id === 'neg';
  ctx.save(); ctx.translate(x, y); ctx.lineWidth = 1.5; ctx.strokeStyle = '#004A6E';
  ctx.fillStyle = numeric ? '#FFFFFF' : id === 'second' ? '#0092AC' : '#004A6E';
  rounded(ctx, 0, 0, 84, 54, direction ? 25 : 12);
  if (direction) {
    ctx.save(); ctx.translate(6, 0); ctx.scale(1.3, 1.3);
    ctx.fillStyle = '#0092AC';
    const box = direction.box.match(/\d+/g).map(Number); ctx.fillRect(...box);
    Object.entries(DIRECTIONS).forEach(([key, d]) => {
      const points = d.triangle.match(/\d+/g).map(Number);
      ctx.globalAlpha = key === id ? 1 : .22; ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.moveTo(points[0], points[1]); ctx.lineTo(points[2], points[3]); ctx.lineTo(points[4], points[5]); ctx.closePath(); ctx.fill();
    });
    ctx.globalAlpha = 1; ctx.fillStyle = '#004A6E'; ctx.beginPath(); ctx.arc(28, 21, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  } else {
    ctx.fillStyle = numeric ? '#004A6E' : id === 'second' ? '#000000' : '#FFFFFF';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '20px sans-serif';
    const text = (label, px, py, size = 20) => { ctx.font = size + 'px sans-serif'; ctx.fillText(label, px, py); };
    const box = (px, py, w = 10, h = 10) => { ctx.strokeStyle = ctx.fillStyle; ctx.strokeRect(px, py, w, h); };
    if (['sin', 'cos', 'tan'].includes(id)) { text(id, 42, 17, 18); text(id, 38, 39, 18); text('−1', 60, 32, 11); }
    else if (id === 'frac') { box(37, 8); ctx.fillRect(31, 26, 22, 1.5); box(37, 34); }
    else if (id === 'pow') { text('x', 36, 31, 27); box(49, 12); }
    else if (id === 'sq') { text('x', 36, 31, 27); text('2', 53, 17, 14); }
    else if (id === 'exp') { text('e', 18, 31, 22); box(26, 12, 8, 8); text('10', 53, 31, 22); box(65, 12, 8, 8); }
    else if (id === 'pi') { text('π', 28, 28, 27); text('e', 59, 17, 16); text('i', 59, 38, 16); }
    else if (id === 'prb') { text('!', 22, 28, 26); text('nCr', 55, 17, 14); text('nPr', 55, 38, 14); }
    else if (id === 'var') { text('x', 22, 28, 25); text('yzt', 54, 17, 14); text('abcd', 54, 38, 13); }
    else { const label = step.keys.join(' → '); text(label, 42, 28, Math.min(numeric ? 27 : 20, 72 / Math.max(1, label.length) * 1.55)); }
  }
  ctx.restore();
}
function createSequencePNG(session) {
  return new Promise((resolve, reject) => {
    try {
      const layout = sequenceLayout(session), canvas = G.document.createElement('canvas');
      canvas.width = layout.width; canvas.height = layout.height;
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas image generation is unavailable.');
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, layout.width, layout.height);
      layout.keys.forEach(({ step, x, y, arrow }) => {
        if (arrow) { ctx.fillStyle = '#0092AC'; ctx.font = '25px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⇒', x - 22, y + 27); }
        drawKey(ctx, step, x, y);
      });
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG encoding failed.')), 'image/png');
    } catch (error) { reject(error); }
  });
}
TI.recorder = { Recorder, keySequence, serialize, sequenceLayout, drawKey, createSequencePNG };
TI.startRecorder = (app, root) => new Recorder(app, root);
})(calculatorScope);

export function mountCalculator(host) {
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = styles;
  const template = document.createElement('template'); template.innerHTML = markup;
  shadow.replaceChildren(style, template.content.cloneNode(true));
  const root = shadow.querySelector('#calc');
  const app = calculatorScope.TI.start(root);
  calculatorScope.TI.startDisplayCopy(app);
  calculatorScope.TI.startRecorder(app, shadow.querySelector('#keypress-recorder'));
  let destroyed = false;
  const screen = root.querySelector('.lcd');
  screen.title = 'Click to copy the screen. Drag onto the canvas to place an image.';
  return { screen, captureScreen: () => {
    const box = screen.getBoundingClientRect();
    // The panel changes the real cqw container width, not a CSS transform.
    // DOM rectangles and computed font/border sizes therefore share CSS pixels.
    return calculatorScope.TI.displayCopy.capturePNG(screen).then(blob => ({ blob, width: box.width, height: box.height }));
  }, focus: () => root.focus({ preventScroll: true }), destroy: () => {
    if (destroyed) return;
    destroyed = true;
    app.destroy(); shadow.replaceChildren();
  } };
}
