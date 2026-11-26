/* Price window — окно тарифа DeepSeek рядом с балансом в подвале боковой панели.
 *
 * DeepSeek делит сутки на пик (полная цена) и офф-пик (вдвое дешевле):
 * пик — 01:00–04:00 и 06:00–10:00 UTC, только по будням, кроме праздников КНР.
 * Бейдж показывает, что действует сейчас и до какого часа; клик раскрывает
 * карточку с ближайшими окнами и ценами.
 *
 * Защитный по образцу balance-badge: установка в слот, расчёт и рендер
 * обёрнуты, чтобы отсутствующий слот не валил загрузку клиента.
 */
window.__ModuleLoader__.load({
	id: "dsh-price-window",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		/** Портал в body: подвал сайдбара живёт в transform-контейнере, где fixed ломается. */
		let reactDom = null;
		try {
			reactDom = require("react-dom");
		} catch (error) {
			console.warn("[price-window] react-dom unavailable, falling back to inline panel", error);
		}

		/** Пиковые окна в минутах от 00:00 UTC: 01:00–04:00 и 06:00–10:00. */
		const PEAK_WINDOWS_UTC = [
			[60, 240],
			[360, 600]
		];

		/**
		 * Пояс, в котором показываются часы. По умолчанию Тольятти (UTC+4):
		 * часы ПК могут стоять на чужом поясе (у владельца — Берлин, UTC+1),
		 * и тогда «пик до 14:00» было бы временем не того города.
		 * Другой город — поменять offsetMinutes (Москва 180, Екатеринбург 300).
		 */
		const DISPLAY_ZONE = { city: "Тольятти", offsetMinutes: 240 };

		/** Пик только по будням (0 — воскресенье). */
		const PEAK_WEEKDAYS = [1, 2, 3, 4, 5];
		/**
		 * Праздники КНР в офф-пике целиком. Даты в UTC, формат «2026-10-01».
		 * Список пуст намеренно: даты объявляет Госсовет КНР, а выдуманная дата
		 * показала бы «дорого» в дешёвый день. Добавлять по мере публикации.
		 */
		const HOLIDAYS = new Set([]);
		/** Обновление подписи (остаток времени точнее минуты не нужен). */
		const TICK_MS = 20000;
		/** Насколько далеко вперёд/назад ищем границу окна (дней). */
		const LOOKAHEAD_DAYS = 10;
		/** Сколько окон показывать в раскрытой карточке. */
		const WINDOW_ROWS = 6;
		/** Цвет дорогого окна. */
		const PEAK_COLOR = "#e05a5a";
		/** Цвет дешёвого окна — спокойный зелёный, читаемый в тёмной и светлой теме. */
		const CHEAP_COLOR = "#52b788";
		/** Слот подвала боковой панели, куда ставится бейдж. */
		const SLOT = "sidebar.footer.action";
		/** Порядок: сразу справа от бейджа баланса (у него order 10). */
		const ORDER = 11;
		/** За сколько до смены цены бейдж начинает предупреждать. */
		const SOON_MS = 15 * 60000;
		/** Насколько далеко листается день в карточке (в пределах поиска границ). */
		const MAX_DAY_OFFSET = 7;
		/** Короткие имена дней для подписи окон. */
		const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

		/** Двузначное число. */
		function pad2(value) {
			return value < 10 ? "0" + value : String(value);
		}

		/** Момент (мс) в поясе виджета: поля читаются UTC-геттерами. */
		function zoneDate(ms) {
			return new Date(ms + DISPLAY_ZONE.offsetMinutes * 60000);
		}

		/** Номер суток в поясе виджета: по нему считаются «вчера/завтра». */
		function zoneDayIndex(ms) {
			return Math.floor((ms + DISPLAY_ZONE.offsetMinutes * 60000) / 86400000);
		}

		/** «ЧЧ:ММ» в поясе виджета; принимает миллисекунды или Date. */
		function hhmm(moment) {
			const ms = typeof moment === "number" ? moment : moment.getTime();
			const date = zoneDate(ms);
			return pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes());
		}

		/** «ЧЧ:ММ» из минут суток с переносом через полночь. */
		function hhmmOfMinutes(minutes) {
			const wrapped = ((minutes % 1440) + 1440) % 1440;
			return pad2(Math.floor(wrapped / 60)) + ":" + pad2(wrapped % 60);
		}

		/** Дата в UTC по ключу «ГГГГ-ММ-ДД». */
		function utcDayKey(date) {
			return date.getUTCFullYear() + "-" + pad2(date.getUTCMonth() + 1) + "-" + pad2(date.getUTCDate());
		}

		/** Пик ли в этот момент (без учёта праздников — их добавляет вызывающий). */
		function isPeakAt(ms, holidays) {
			const date = new Date(ms);
			if (PEAK_WEEKDAYS.indexOf(date.getUTCDay()) < 0) return false;
			const days = holidays || HOLIDAYS;
			if (days && typeof days.has === "function" && days.has(utcDayKey(date))) return false;
			const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
			for (const window of PEAK_WINDOWS_UTC) {
				if (minute >= window[0] && minute < window[1]) return true;
			}
			return false;
		}

		/** Первая граница смены цены после `ms`, либо null в пределах поиска. */
		function nextSwitch(ms, holidays) {
			const peak = isPeakAt(ms, holidays);
			const limit = ms + LOOKAHEAD_DAYS * 86400000;
			let probe = ms;
			while (probe <= limit) {
				probe += 60000;
				if (isPeakAt(probe, holidays) !== peak) return probe;
			}
			return null;
		}

		/**
		 * Последняя граница смены цены до `ms`, либо null в пределах поиска.
		 * Шаг назад даёт последнюю минуту прежнего окна, поэтому граница — она + 1 мин.
		 */
		function prevSwitch(ms, holidays) {
			const peak = isPeakAt(ms, holidays);
			const limit = ms - LOOKAHEAD_DAYS * 86400000;
			let probe = ms;
			while (probe >= limit) {
				probe -= 60000;
				if (isPeakAt(probe, holidays) !== peak) return probe + 60000;
			}
			return null;
		}

		/**
		 * Ближайшие окна подряд, начиная с текущего: [{ startMs, endMs, peak }].
		 * Первая строка — то, что действует сейчас.
		 */
		function upcomingWindows(now, count, holidays) {
			const rows = [];
			const total = typeof count === "number" && count > 0 ? count : WINDOW_ROWS;
			let cursor = prevSwitch(now, holidays);
			if (cursor === null) cursor = now;
			let peak = isPeakAt(now, holidays);
			for (let index = 0; index < total; index += 1) {
				const end = nextSwitch(cursor, holidays);
				if (end === null) break;
				rows.push({ startMs: cursor, endMs: end, peak, current: index === 0 });
				cursor = end;
				peak = !peak;
			}
			return rows;
		}

		/** Разница календарных дней в поясе виджета: 0 — сегодня, 1 — завтра. */
		function dayDiff(ms, nowMs) {
			return zoneDayIndex(ms) - zoneDayIndex(nowMs);
		}

		/**
		 * Куски одного местного дня: [{ startMs, endMs, peak }], начиная с 00:00.
		 * `dayOffset` — сдвиг дня от сегодняшнего (0 — сегодня, 1 — завтра).
		 */
		function dayWindows(nowMs, dayOffset, holidays) {
			const rows = [];
			const base = zoneDate(nowMs);
			const offset = typeof dayOffset === "number" ? dayOffset : 0;
			const zoneShift = DISPLAY_ZONE.offsetMinutes * 60000;
			const dayStart = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offset, 0, 0, 0, 0) - zoneShift;
			const dayEnd = dayStart + 86400000;
			let cursor = dayStart;
			let peak = isPeakAt(cursor, holidays);
			while (cursor < dayEnd) {
				const boundary = nextSwitch(cursor, holidays);
				const end = boundary === null ? dayEnd : Math.min(boundary, dayEnd);
				rows.push({ startMs: cursor, endMs: end, peak });
				if (boundary === null || boundary >= dayEnd) break;
				cursor = boundary;
				peak = !peak;
			}
			return rows;
		}

		/** Сколько часов дня идут по полной цене. */
		function peakHours(rows) {
			let ms = 0;
			for (const row of rows) {
				if (row.peak) ms += row.endMs - row.startMs;
			}
			return Math.round((ms / 3600000) * 10) / 10;
		}

		/** Подпись дня в навигации: «Сегодня, 13.11», «Завтра, 14.11», «пн, 16.11». */
		function dayLabel(nowMs, dayOffset) {
			const day = zoneDate(nowMs + dayOffset * 86400000);
			const date = pad2(day.getUTCDate()) + "." + pad2(day.getUTCMonth() + 1);
			if (dayOffset === 0) return "Сегодня, " + date;
			if (dayOffset === 1) return "Завтра, " + date;
			if (dayOffset === -1) return "Вчера, " + date;
			return WEEKDAYS[day.getUTCDay()] + ", " + date;
		}

		/** Подпись дня перед временем: «», «завтра », «пн ». */
		function dayHint(ms, nowMs) {
			const diff = dayDiff(ms, nowMs);
			if (diff === 0) return "";
			if (diff === 1) return "завтра ";
			return WEEKDAYS[zoneDate(ms).getUTCDay()] + " ";
		}

		/** «10:00–14:00», с подсказкой дня, если окно выходит за сутки. */
		function spanLabel(startMs, endMs, nowMs) {
			const startHint = dayHint(startMs, nowMs);
			const endHint = dayHint(endMs, nowMs);
			const start = hhmm(new Date(startMs));
			const end = hhmm(new Date(endMs));
			if (startHint === endHint) return (startHint || "") + start + " – " + end;
			return startHint + start + " – " + endHint + end;
		}

		/** Подпись куска внутри одного дня: «00:00 – 05:00», конец суток — «24:00». */
		function daySpan(row) {
			const end = zoneDate(row.endMs);
			const midnight = end.getUTCHours() === 0 && end.getUTCMinutes() === 0;
			return hhmm(row.startMs) + " – " + (midnight ? "24:00" : hhmm(row.endMs));
		}

		/** «1 ч 7 мин», «38 мин», «меньше минуты». */
		function formatDuration(ms) {
			const minutes = Math.max(0, Math.floor(ms / 60000));
			if (minutes < 1) return "меньше минуты";
			const hours = Math.floor(minutes / 60);
			const rest = minutes % 60;
			if (hours === 0) return rest + " мин";
			if (rest === 0) return hours + " ч";
			return hours + " ч " + rest + " мин";
		}

		/** Смещение пояса в часах: «UTC+4». */
		function timezoneLabel(offsetMinutes) {
			if (!offsetMinutes) return "UTC";
			const sign = offsetMinutes > 0 ? "+" : "−";
			const total = Math.abs(offsetMinutes);
			const hours = Math.floor(total / 60);
			const rest = total % 60;
			return "UTC" + sign + hours + (rest ? ":" + pad2(rest) : "");
		}

		/** Пиковые интервалы в местном времени: «05:00–08:00, 10:00–14:00». */
		function peakWindowsLocal(offsetMinutes) {
			return PEAK_WINDOWS_UTC
				.map((window) => hhmmOfMinutes(window[0] + offsetMinutes) + "–" + hhmmOfMinutes(window[1] + offsetMinutes))
				.join(", ");
		}

		/**
		 * Полное состояние на момент `now`: дорого/дёшево, граница и подписи.
		 * Чистая функция — её же проверяет tests/price-window.test.mjs.
		 */
		function stateFor(now, holidays) {
			const peak = isPeakAt(now, holidays);
			const endMs = nextSwitch(now, holidays);
			const startMs = prevSwitch(now, holidays);
			const offsetMinutes = DISPLAY_ZONE.offsetMinutes;
			const spanStart = startMs === null ? "?" : hhmm(startMs);
			const spanEnd = endMs === null ? "?" : hhmm(endMs);
			const tz = DISPLAY_ZONE.city + ", " + timezoneLabel(offsetMinutes);
			const remaining = endMs === null ? null : formatDuration(endMs - now);
			const toSwitchMs = endMs === null ? null : endMs - now;
			const soon = toSwitchMs !== null && toSwitchMs > 0 && toSwitchMs <= SOON_MS;
			const title = [
				peak
					? "Сейчас ДОРОГО: полная цена (" + spanStart + "–" + spanEnd + ")."
					: "Сейчас ДЕШЕВО: скидка 50% (" + spanStart + "–" + spanEnd + ").",
				"Пик по DeepSeek: пн–пт " + peakWindowsLocal(offsetMinutes) + " (" + tz + ").",
				"Офф-пик — вдвое дешевле: всё остальное время, выходные и праздники КНР.",
				endMs === null
					? "Ближайшая смена цены не найдена."
					: "Цена сменится в " + hhmm(endMs) + " — через " + remaining + ".",
				soon ? "Внимание: через " + formatDuration(toSwitchMs) + " станет " + (peak ? "дешевле" : "дороже") + "." : ""
			].filter(Boolean).join("\n");
			return {
				peak,
				color: peak ? PEAK_COLOR : CHEAP_COLOR,
				soon,
				toSwitchMs,
				soonColor: soon ? (peak ? CHEAP_COLOR : PEAK_COLOR) : null,
				windowStart: spanStart,
				windowEnd: spanEnd,
				until: endMs === null ? "" : hhmm(endMs),
				lastSwitch: startMs === null ? "" : hhmm(startMs),
				remaining,
				title,
				tz,
				text: peak ? "пик · до " + (endMs === null ? "?" : hhmm(endMs)) : "−50% · до " + (endMs === null ? "?" : hhmm(endMs)),
				soonText: soon ? "через " + formatDuration(toSwitchMs) : ""
			};
		}

		/** #rrggbb + прозрачность → rgba(...), чтобы бейдж жил в любой теме. */
		function hexToRgba(hex, alpha) {
			const value = String(hex || "").replace("#", "");
			if (value.length !== 6) return "rgba(128,128,128," + alpha + ")";
			const r = parseInt(value.slice(0, 2), 16);
			const g = parseInt(value.slice(2, 4), 16);
			const b = parseInt(value.slice(4, 6), 16);
			return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
		}

		/** Одна строка списка окон: точка, интервал, подпись справа. */
		function windowRow(row, nowMs, key) {
			const color = row.peak ? PEAK_COLOR : CHEAP_COLOR;
			return react.createElement(
				"div",
				{
					key,
					style: {
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "5px 0",
						fontSize: 12,
						lineHeight: 1.35,
						opacity: row.current ? 1 : 0.85
					}
				},
				react.createElement("span", {
					"aria-hidden": "true",
					style: { width: 6, height: 6, flex: "0 0 auto", borderRadius: "50%", background: color }
				}),
				react.createElement(
					"span",
					{ style: { flex: "1 1 auto", fontVariantNumeric: "tabular-nums" } },
					daySpan(row),
					row.current ? react.createElement("span", { style: { marginLeft: 6, opacity: 0.6 } }, " · сейчас") : null
				),
				react.createElement(
					"span",
					{ style: { flex: "0 0 auto", color: "var(--dsw-alias-label-tertiary, #8b9096)" } },
					row.peak ? "дорого" : "−50%"
				)
			);
		}

		/** Строка таблицы цен: подпись и два значения (пик / офф-пик). */
		function priceRow(label, peakPrice, cheapPrice) {
			const cell = { flex: "0 0 auto", width: 54, textAlign: "right", fontVariantNumeric: "tabular-nums" };
			return react.createElement(
				"div",
				{ style: { display: "flex", gap: 8, fontSize: 11, lineHeight: 1.55 } },
				react.createElement("span", { style: { flex: "1 1 auto", opacity: 0.85 } }, label),
				react.createElement("span", { style: cell }, peakPrice),
				react.createElement("span", { style: cell }, cheapPrice)
			);
		}

		/** Сводка дня для заголовка: «дорого 7 ч» или «весь день −50%». */
		function daySummary(rows) {
			const hours = peakHours(rows);
			if (hours === 0) return "весь день −50%";
			if (hours >= 24) return "весь день пик";
			return "дорого " + hours + " ч";
		}

		/** Кнопки листания дней: ‹ · сегодня · ›. */
		function navRow(dayOffset, onDayChange) {
			const button = (label, delta, title, strong) => react.createElement(
				"button",
				{
					type: "button",
					key: label + delta,
					onClick: () => onDayChange(delta),
					title,
					"aria-label": title,
					style: {
						flex: "0 0 auto",
						minWidth: 22,
						height: 20,
						padding: "0 6px",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))",
						borderRadius: 6,
						background: "transparent",
						color: strong ? "var(--dsw-alias-label-primary, currentColor)" : "var(--dsw-alias-label-secondary, #9aa0a6)",
						fontSize: 11,
						lineHeight: 1,
						cursor: "pointer"
					}
				},
				label
			);
			const children = [button("‹", -1, "Предыдущий день")];
			if (dayOffset !== 0) children.push(button("сегодня", -dayOffset, "Вернуться к сегодняшнему дню", true));
			children.push(button("›", 1, "Следующий день"));
			return react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 2, marginBottom: 2 } }, children);
		}

		/** Пометка «сейчас» на текущем куске дня. */
		function withCurrent(row, isToday, now) {
			return {
				startMs: row.startMs,
				endMs: row.endMs,
				peak: row.peak,
				current: isToday && now >= row.startMs && now < row.endMs
			};
		}

		/** Раскрытая карточка: текущее окно, ближайшие интервалы, цены. */
		function panel(now, rect, dayOffset, onDayChange, onClose) {
			const info = stateFor(now);
			const rows = dayWindows(now, dayOffset);
			const isToday = dayOffset === 0;
			const offsetMinutes = DISPLAY_ZONE.offsetMinutes;
			const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 360;
			const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720;
			const width = Math.min(320, viewportWidth - 24);
			/** Левая граница по бейджу, но не за край экрана. */
			const left = rect ? Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - width - 8)) : 8;
			/** Карточка растёт вверх от бейджа. */
			const bottom = rect ? Math.max(8, viewportHeight - rect.top + 8) : 8;
			const spaceAbove = Math.max(180, viewportHeight - bottom - 16);
			return react.createElement(
				"div",
				{
					role: "dialog",
					"aria-label": "Тариф DeepSeek: интервалы цен",
					"data-dsh-price-panel": "",
					style: {
						position: "fixed",
						left,
						bottom,
						width,
						maxHeight: Math.min(spaceAbove, viewportHeight - 24),
						overflowY: "auto",
						boxSizing: "border-box",
						padding: "12px 14px",
						borderRadius: 12,
						background: "var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-2, #26262a))",
						backdropFilter: "blur(16px) saturate(1.1)",
						WebkitBackdropFilter: "blur(16px) saturate(1.1)",
						border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))",
						boxShadow: "var(--dsw-shadow-lv2, 0 8px 24px rgba(0,0,0,0.35))",
						color: "var(--dsw-alias-label-primary, currentColor)",
						fontSize: 12,
						lineHeight: 1.45,
						zIndex: 2147483000
					}
				},
				react.createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
					react.createElement("span", {
						"aria-hidden": "true",
						style: { width: 8, height: 8, flex: "0 0 auto", borderRadius: "50%", background: info.color }
					}),
					react.createElement("span", { style: { flex: "1 1 auto", fontWeight: 600 } }, "Тариф DeepSeek"),
					react.createElement(
						"button",
						{
							type: "button",
							onClick: onClose,
							"aria-label": "Закрыть",
							style: {
								flex: "0 0 auto",
								width: 22,
								height: 22,
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
								border: "none",
								borderRadius: 6,
								background: "transparent",
								color: "var(--dsw-alias-label-secondary, #9aa0a6)",
								cursor: "pointer",
								fontSize: 15,
								lineHeight: 1
							}
						},
						"×"
					)
				),
				react.createElement(
					"div",
					{ style: { marginBottom: 8 } },
					info.peak ? "Сейчас дорого — полная цена." : "Сейчас дёшево — скидка 50%.",
					" ",
					react.createElement(
						"span",
						{ style: { color: "var(--dsw-alias-label-secondary, #9aa0a6)" } },
						info.windowStart + "–" + info.windowEnd + (info.remaining ? ", осталось " + info.remaining : "")
					)
				),
				react.createElement(
					"div",
					{
						style: {
							borderTop: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))",
							paddingTop: 6,
							marginBottom: 2
						}
					},
					react.createElement(
						"div",
						{ style: { fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase", opacity: 0.6, marginBottom: 2 } },
						dayLabel(now, dayOffset) + " · " + daySummary(rows)
					),
					navRow(dayOffset, onDayChange), rows.map((row, index) => windowRow(withCurrent(row, isToday, now), now, "w" + index))
				),
				react.createElement(
					"div",
					{
						style: {
							marginTop: 8,
							paddingTop: 8,
							borderTop: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12))",
							fontSize: 11,
							color: "var(--dsw-alias-label-secondary, #9aa0a6)"
						}
					},
					"Пик: пн–пт " + peakWindowsLocal(offsetMinutes) + " (" + info.tz + ").",
					react.createElement("br", null),
					"Офф-пик вдвое дешевле: ночи, выходные, праздники КНР.",
					react.createElement(
						"div",
						{ style: { marginTop: 6, marginBottom: 2, opacity: 0.75 } },
						"Цены deepseek-flash за 1M токенов:"
					),
					react.createElement(
						"div",
						{ style: { display: "flex", gap: 8, fontSize: 10, opacity: 0.55 } },
						react.createElement("span", { style: { flex: "1 1 auto" } }, ""),
						react.createElement("span", { style: { flex: "0 0 auto", width: 54, textAlign: "right" } }, "пик"),
						react.createElement("span", { style: { flex: "0 0 auto", width: 54, textAlign: "right" } }, "офф-пик")
					),
					priceRow("вход · из кеша", "$0.006", "$0.003"),
					priceRow("вход · без кеша", "$0.30", "$0.15"),
					priceRow("выход", "$1.20", "$0.60"),
					react.createElement("div", { style: { marginTop: 6, opacity: 0.7 } }, "Esc или клик мимо — закрыть.")
				)
			);
		}

		/** Бейдж: цветная точка, короткая подпись и раскрывающаяся карточка по клику. */
		function PriceWindowBadge() {
			const [now, setNow] = react.useState(() => Date.now());
			const [opened, setOpened] = react.useState(false);
			const [rect, setRect] = react.useState(null);
			const [dayOffset, setDayOffset] = react.useState(0);
			const badgeRef = react.useRef(null);

			react.useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), TICK_MS);
				const onVisible = () => {
					if (typeof document !== "undefined" && document.visibilityState === "visible") setNow(Date.now());
				};
				if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
				return () => {
					clearInterval(timer);
					if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
				};
			}, []);

			react.useEffect(() => {
				if (!opened || typeof document === "undefined") return undefined;
				const close = (event) => {
					const holder = badgeRef.current && badgeRef.current.parentElement;
					if (holder && event && event.target && holder.contains(event.target)) return;
					if (event && event.target && event.target.closest && event.target.closest("[data-dsh-price-panel]")) return;
					setOpened(false);
				};
				const onKey = (event) => {
					if (event && event.key === "Escape") setOpened(false);
				};
				const onResize = () => setOpened(false);
				document.addEventListener("mousedown", close, true);
				document.addEventListener("keydown", onKey, true);
				if (typeof window !== "undefined") window.addEventListener("resize", onResize);
				return () => {
					document.removeEventListener("mousedown", close, true);
					document.removeEventListener("keydown", onKey, true);
					if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
				};
			}, [opened]);

			let info;
			try {
				info = stateFor(now);
			} catch (error) {
				console.warn("[price-window] state failed", error);
				return null;
			}

			const toggle = () => {
				if (!opened) setDayOffset(0);
				const node = badgeRef.current;
				if (!opened && node && typeof node.getBoundingClientRect === "function") {
					try {
						setRect(node.getBoundingClientRect());
					} catch (error) {
						console.warn("[price-window] rect failed", error);
					}
				}
				setOpened(!opened);
			};

			const accent = info.soon ? info.soonColor : info.color;

			const badge = react.createElement(
				"span",
				{
					ref: badgeRef,
					className: "dsh-price-window",
					"data-dsh-price-window": info.soon ? "soon" : info.peak ? "peak" : "cheap",
					role: "button",
					tabIndex: 0,
					"aria-expanded": opened,
					"aria-haspopup": "dialog",
					"aria-label": info.title,
					title: opened ? "" : info.title,
					onClick: toggle,
					onKeyDown: (event) => {
						if (event && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							toggle();
						}
					},
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 5,
						height: 28,
						padding: "0 8px",
						borderRadius: 999,
						fontSize: 12,
						fontVariantNumeric: "tabular-nums",
						whiteSpace: "nowrap",
						maxWidth: "100%",
						overflow: "hidden",
						textOverflow: "ellipsis",
						cursor: "pointer",
						userSelect: "none",
						color: "var(--dsw-alias-label-secondary, currentColor)",
						border: "1px solid " + hexToRgba(accent, info.soon ? 0.6 : 0.45),
						background: hexToRgba(accent, opened ? 0.24 : info.soon ? 0.2 : 0.14)
					}
				},
				react.createElement("span", {
					"aria-hidden": "true",
					style: { width: 6, height: 6, flex: "0 0 auto", borderRadius: "50%", background: accent }
				}),
				react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, info.soon ? info.soonText : info.text)
			);

			if (!opened) return badge;
			const card = panel(now, rect, dayOffset, (delta) => {
				setDayOffset((current) => Math.max(-MAX_DAY_OFFSET, Math.min(MAX_DAY_OFFSET, current + delta)));
			}, () => setOpened(false));
			const usePortal = reactDom && typeof reactDom.createPortal === "function" && typeof document !== "undefined";
			return react.createElement(react.Fragment, null, badge, usePortal ? reactDom.createPortal(card, document.body) : card);
		}

		/** Нужен только реестр слотов. */
		const inject = ["slots"];

		/** Поставить бейдж, повторяя попытки, пока слот не объявлен. */
		function place(ctx, attempt) {
			const tries = typeof attempt === "number" ? attempt : 0;
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register({
					name: SLOT,
					id: "price-window",
					order: ORDER
				}, PriceWindowBadge));
				return true;
			} catch (error) {
				if (tries < 20) {
					const timer = setTimeout(() => place(ctx, tries + 1), 1000);
					if (timer && typeof timer.unref === "function") timer.unref();
				} else {
					console.warn("[price-window] could not place the footer action", error);
				}
				return false;
			}
		}

		/** Никогда не бросать наружу: сломанный бейдж не должен ломать клиент. */
		function apply(ctx) {
			try {
				place(ctx);
			} catch (error) {
				console.warn("[price-window] apply failed", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		/** Чистые функции для самопроверки; рантайм их не использует. */
		exports.__test = {
			isPeakAt,
			nextSwitch,
			prevSwitch,
			upcomingWindows,
			dayWindows,
			dayLabel,
			daySummary,
			daySpan,
			peakHours,
			stateFor,
			formatDuration,
			hhmm,
			hhmmOfMinutes,
			DISPLAY_ZONE,
			timezoneLabel,
			peakWindowsLocal,
			spanLabel,
			dayHint,
			PEAK_WINDOWS_UTC,
			HOLIDAYS
		};
		return module.exports;
	}
});
