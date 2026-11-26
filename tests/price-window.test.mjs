/**
 * Self-check for the price window badge: runs the shipped client bundle with a
 * stub module loader and checks the pure pricing functions on UTC instants.
 *
 *   node tests/price-window.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** Capture the module definition instead of registering it in a browser. */
let definition = null
const fakeWindow = {
	__ModuleLoader__: {
		load: (def) => {
			definition = def
		}
	}
}
// eslint-disable-next-line no-new-func
new Function('window', source)(fakeWindow)
if (!definition || definition.id !== 'dsh-price-window' || typeof definition.factory !== 'function') {
	throw new Error('client bundle did not register id "dsh-price-window"')
}

/** React stub: nothing renders in this check, only pure code is exercised. */
const reactStub = {
	createElement: () => null,
	useState: () => [0, () => {}],
	useEffect: () => {},
	useRef: () => ({ current: null }),
	Fragment: {}
}
/** react-dom stub: the panel is portaled to body in the browser, not here. */
const reactDomStub = {
	createPortal: (node) => node
}
const exported = definition.factory((name) => {
	if (name === 'react') return reactStub
	if (name === 'react-dom') return reactDomStub
	throw new Error('unexpected require: ' + name)
})
const { __test } = exported
if (!__test) throw new Error('client bundle exposes no __test helpers')

let failures = 0
/** One assertion with a readable message. */
function check(label, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) {
		failures += 1
		console.error(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
	} else {
		console.log(`ok   ${label}`)
	}
}

const at = (iso) => Date.parse(iso)

// Пик 06:00–10:00 UTC, будни. Четверг 13.11.2026.
check('09:27Z четверг — пик', __test.isPeakAt(at('2026-11-13T09:27:00Z')), true)
check('09:27Z — граница 10:00Z', new Date(__test.nextSwitch(at('2026-11-13T09:27:00Z'))).toISOString(), '2026-11-13T10:00:00.000Z')
check('10:00Z четверг — офф-пик', __test.isPeakAt(at('2026-11-13T10:00:00Z')), false)
// После пятницы 10:00Z ближайший пик — понедельник 01:00Z.
check('пятница 10:00Z → пик в понедельник 01:00Z', new Date(__test.nextSwitch(at('2026-11-13T10:00:00Z'))).toISOString(), '2026-11-16T01:00:00.000Z')
// Пик 01:00–04:00 UTC.
check('03:30Z — пик', __test.isPeakAt(at('2026-11-13T03:30:00Z')), true)
check('03:30Z — до 04:00Z', new Date(__test.nextSwitch(at('2026-11-13T03:30:00Z'))).toISOString(), '2026-11-13T04:00:00.000Z')
check('00:30Z — офф-пик, до 01:00Z', new Date(__test.nextSwitch(at('2026-11-13T00:30:00Z'))).toISOString(), '2026-11-13T01:00:00.000Z')
// Начало текущего окна — сама граница, а не последняя минута прошлого.
check('09:27Z — окно началось в 06:00Z', new Date(__test.prevSwitch(at('2026-11-13T09:27:00Z'))).toISOString(), '2026-11-13T06:00:00.000Z')
check('10:15Z — окно началось в 10:00Z', new Date(__test.prevSwitch(at('2026-11-13T10:15:00Z'))).toISOString(), '2026-11-13T10:00:00.000Z')
// Выходные целиком в офф-пике.
check('суббота 07:00Z — офф-пик', __test.isPeakAt(at('2026-11-14T07:00:00Z')), false)
check('суббота 07:00Z → пик в понедельник 01:00Z', new Date(__test.nextSwitch(at('2026-11-14T07:00:00Z'))).toISOString(), '2026-11-16T01:00:00.000Z')
// Праздник КНР обнуляет пик на весь день.
const holidays = new Set(['2026-11-13'])
check('праздник 13.11 — не пик даже в 09:27Z', __test.isPeakAt(at('2026-11-13T09:27:00Z'), holidays), false)
check('праздник 13.11 → пик в понедельник', new Date(__test.nextSwitch(at('2026-11-13T09:27:00Z'), holidays)).toISOString(), '2026-11-16T01:00:00.000Z')
// Границы окна: начало пика включено, конец не включён.
check('ровно 01:00Z — пик', __test.isPeakAt(at('2026-11-13T01:00:00Z')), true)
check('ровно 04:00Z — офф-пик', __test.isPeakAt(at('2026-11-13T04:00:00Z')), false)
check('ровно 06:00Z — пик', __test.isPeakAt(at('2026-11-13T06:00:00Z')), true)
check('ровно 10:00Z — офф-пик', __test.isPeakAt(at('2026-11-13T10:00:00Z')), false)

// Форматирование.
check('минуты 38', __test.formatDuration(38 * 60000), '38 мин')
check('1 ч 7 мин', __test.formatDuration(67 * 60000), '1 ч 7 мин')
check('ровно 2 ч', __test.formatDuration(120 * 60000), '2 ч')
check('меньше минуты', __test.formatDuration(20 * 1000), 'меньше минуты')
check('00:00 из 1440 минут', __test.hhmmOfMinutes(1440), '00:00')
check('00:10 из 1450 минут', __test.hhmmOfMinutes(1450), '00:10')
check('окна в UTC+4', __test.peakWindowsLocal(240), '05:00–08:00, 10:00–14:00')
check('часовой пояс', __test.timezoneLabel(240), 'UTC+4')
check('пояс виджета по умолчанию — Тольятти', [__test.DISPLAY_ZONE.city, __test.DISPLAY_ZONE.offsetMinutes], ['Тольятти', 240])
check('hhmm в поясе виджета: 06:00Z → 10:00', __test.hhmm(at('2026-11-13T06:00:00Z')), '10:00')
check('hhmm в поясе виджета: 00:30Z → 04:30', __test.hhmm(at('2026-11-13T00:30:00Z')), '04:30')
check('граница суток в поясе: 19:59Z — ещё 13.11', __test.dayLabel(at('2026-11-13T19:59:00Z'), 0), 'Сегодня, 13.11')
check('граница суток в поясе: 20:00Z — уже 14.11', __test.dayLabel(at('2026-11-13T20:00:00Z'), 0), 'Сегодня, 14.11')
check('14.11 в поясе — суббота целиком дешёвая', __test.dayWindows(at('2026-11-13T20:00:00Z'), 0).length, 1)

// Полное состояние: подпись, цвет и текст подсказки.
const peakState = __test.stateFor(at('2026-11-13T09:27:00Z'))
check('состояние пика', peakState.peak, true)
check('цвет пика красный', peakState.color, '#e05a5a')
check('подпись пика начинается с «пик»', peakState.text.startsWith('пик · до '), true)
check('подсказка говорит про ДОРОГО', peakState.title.includes('Сейчас ДОРОГО'), true)
check('подпись пояса с городом', peakState.tz, 'Тольятти, UTC+4')
check('кусок дня в поясе: 00:00 – 05:00', __test.daySpan({ startMs: at('2026-11-13T20:00:00Z'), endMs: at('2026-11-14T01:00:00Z') }), '00:00 – 05:00')
check('конец суток подписан 24:00', __test.daySpan({ startMs: at('2026-11-14T10:00:00Z'), endMs: at('2026-11-14T20:00:00Z') }), '14:00 – 24:00')
const cheapState = __test.stateFor(at('2026-11-13T10:00:00Z'))
check('состояние офф-пика', cheapState.peak, false)
check('цвет офф-пика зелёный', cheapState.color, '#52b788')
check('подпись офф-пика про −50%', cheapState.text.startsWith('−50% · до '), true)
check('подсказка говорит про ДЕШЕВО', cheapState.title.includes('Сейчас ДЕШЕВО'), true)

// Список ближайших окон для раскрытой карточки.
const rows = __test.upcomingWindows(at('2026-11-13T10:00:00Z'), 4)
check('окон в списке', rows.length, 4)
check('первое окно — текущее и дешёвое', [rows[0].peak, rows[0].current], [false, true])
check('первое окно: 10:00Z → понедельник 01:00Z', [new Date(rows[0].startMs).toISOString(), new Date(rows[0].endMs).toISOString()], ['2026-11-13T10:00:00.000Z', '2026-11-16T01:00:00.000Z'])
check('второе окно — пик 01:00–04:00Z понедельника', [rows[1].peak, new Date(rows[1].startMs).toISOString(), new Date(rows[1].endMs).toISOString()], [true, '2026-11-16T01:00:00.000Z', '2026-11-16T04:00:00.000Z'])
check('третье окно — дешёвое 04:00–06:00Z', [rows[2].peak, new Date(rows[2].endMs).toISOString()], [false, '2026-11-16T06:00:00.000Z'])
check('четвёртое окно — пик 06:00–10:00Z', [rows[3].peak, new Date(rows[3].endMs).toISOString()], [true, '2026-11-16T10:00:00.000Z'])
check('окна идут подряд без дыр', rows.every((row, i) => i === 0 || rows[i - 1].endMs === row.startMs), true)
check('подпись окна в формате «[день] ЧЧ:ММ – [день] ЧЧ:ММ»', /^([а-я]{2} |завтра )?\d\d:\d\d – ([а-я]{2} |завтра )?\d\d:\d\d$/.test(__test.spanLabel(rows[0].startMs, rows[0].endMs, at('2026-11-13T09:27:00Z'))), true)

// День целиком: куски от 00:00 до 24:00 и сводка.
const friday = __test.dayWindows(at('2026-11-13T10:00:00Z'), 0)
check('пятница: 5 кусков дня', friday.length, 5)
check('пятница: рисунок [деш, дорог, деш, дорог, деш]', friday.map((row) => row.peak), [false, true, false, true, false])
check('пятница: 7 пиковых часов', __test.peakHours(friday), 7)
check('пятница: сводка дня', __test.daySummary(friday), 'дорого 7 ч')
const saturday = __test.dayWindows(at('2026-11-13T10:00:00Z'), 1)
check('суббота: один дешёвый кусок', [saturday.length, saturday[0].peak, __test.peakHours(saturday)], [1, false, 0])
check('суббота: сводка дня', __test.daySummary(saturday), 'весь день −50%')
check('куски дня идут без дыр', friday.every((row, i) => i === 0 || friday[i - 1].endMs === row.startMs), true)
check('подпись дня', /^(Сегодня|Завтра|Вчера|[а-я]{2}), \d\d\.\d\d$/.test(__test.dayLabel(at('2026-11-13T10:00:00Z'), 2)), true)

// Предупреждение за 15 минут до смены цены.
const soon = __test.stateFor(at('2026-11-13T09:50:00Z'))
check('за 10 минут до смены — предупреждение', [soon.soon, soon.soonText], [true, 'через 10 мин'])
check('цвет предупреждения — цвет будущего окна', soon.soonColor, '#52b788')
const notSoon = __test.stateFor(at('2026-11-13T09:40:00Z'))
check('за 20 минут — без предупреждения', [notSoon.soon, notSoon.soonText], [false, ''])

if (failures > 0) {
	console.error(`\n${failures} проверок не прошло`)
	process.exit(1)
}
console.log('\nвсе проверки прошли')
