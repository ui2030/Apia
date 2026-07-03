// ?꾩떆 ?⑥쐞 寃利???computeLighting: 24h ??援ш컙 NaN ?놁쓬쨌踰붿쐞쨌?⑹뼱?쇱슫???곗냽??
import { computeLighting } from '../src/lightingRig.js'

let fail = 0
const check = (cond, msg) => { if (!cond) { console.error('FAIL', msg); fail++ } }

let prev = null
for (let h = 0; h <= 48; h += 0.25) { // ?댄? ????寃쎄퀎 ??踰??듦낵
  const s = computeLighting(h)
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number') check(Number.isFinite(v), `${k} NaN @${h}`)
    else if (Array.isArray(v)) v.forEach((x, i) => check(Number.isFinite(x), `${k}[${i}] NaN @${h}`))
  }
  check(s.ambientIntensity >= 0.15 && s.ambientIntensity <= 0.45, `amb range @${h}: ${s.ambientIntensity}`)
  check(s.keyIntensity >= 0.1 && s.keyIntensity <= 1.05, `key range @${h}: ${s.keyIntensity}`)
  s.ambientColor.forEach((c) => check(c >= 0 && c <= 1, `ambColor range @${h}`))
  // ?곗냽????15遺??ㅽ뀦 媛?湲됱젏???놁쓬(紐⑤뱺 ?섏튂 ?꾨뱶 ?명? < 0.08)
  if (prev) {
    for (const k of Object.keys(s)) {
      const a = prev[k], b = s[k]
      if (typeof b === 'number') check(Math.abs(b - a) < 0.15, `jump ${k} @${h}: ${a}->${b}`)
    }
  }
  prev = s
}
// ?듭빱 ?뺤떆 媛믪씠 ?듭빱 ?뺤쓽? ?쇱튂(蹂닿컙 t=0)
const at18 = computeLighting(18)
check(Math.abs(at18.keyIntensity - 1.0) < 1e-9, `anchor 18h key ${at18.keyIntensity}`)
check(Math.abs(at18.ambientIntensity - 0.26) < 1e-9, `anchor 18h amb`)
// ?뚯닔/24 珥덇낵 ?뺢퇋??check(Number.isFinite(computeLighting(-3).keyIntensity), 'negative hour')
check(Math.abs(computeLighting(25).keyIntensity - computeLighting(1).keyIntensity) < 1e-9, 'wrap 25==1')
console.log(fail ? `LIGHTING UNIT FAILED (${fail})` : 'LIGHTING UNIT PASSED')
process.exit(fail ? 1 : 0)

