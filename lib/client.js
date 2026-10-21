window.__ModuleLoader__.load({
	id: "dsh-simple-tps",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var reactDom = require("react-dom");

		/**
		 * Per-turn throughput readout: a compact `tok/s` pill that mirrors the
		 * built-in usage control, opening a details dialog on click.
		 *
		 * The dialog reuses the harness's own primitives — anchored placement and
		 * outside-dismiss — and the same visual recipe as the usage panel, so it
		 * matches the shipped surface without re-implementing pixels.
		 */

		var NS = "dsh-simple-tps";
		var STYLE_ID = "dsh-simple-tps/readout.css";

		// Primitives are optional: a missing module degrades to text-only and an
		// unpositioned dialog instead of failing the whole plugin.
		var primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			primitives = null;
		}
		var GaugeIcon = primitives === null ? undefined : primitives.IconGaugeOutlineRegular;
		var useAnchoredPosition = primitives === null ? undefined : primitives.useAnchoredPosition;
		var useDismissOnOutsidePointer = primitives === null ? undefined : primitives.useDismissOnOutsidePointer;

		var zh = {
			"tps": "{value} tok/s",
			"tps.gross": "≈{value} tok/s",
			"tps.grossHint": "没记录到首字时刻，此处为整步平均速度（下界）",
			"dialog.title": "本轮速度",
			"dialog.first": "首字（TTFT）",
			"dialog.avg": "首字均值",
			"dialog.speed": "输出速度（TPS）",
			"dialog.steps": "步骤",
			"dialog.exact": "精确窗口",
			"dialog.gross": "整步窗口（下界）",
			"dialog.hint.exact": "输出 tokens ÷ 首字到结束的时长",
			"dialog.hint.gross": "缺少首字时刻，用整步时长；数值偏低"
		};
		var en = {
			"tps": "{value} tok/s",
			"tps.gross": "≈{value} tok/s",
			"tps.grossHint": "No first-token time recorded; this is the whole-step average (a lower bound)",
			"dialog.title": "This turn's speed",
			"dialog.first": "First token (TTFT)",
			"dialog.avg": "Mean first token",
			"dialog.speed": "Output speed (TPS)",
			"dialog.steps": "Steps",
			"dialog.exact": "Exact window",
			"dialog.gross": "Whole-step window (lower bound)",
			"dialog.hint.exact": "Output tokens over the first-token-to-end span",
			"dialog.hint.gross": "No first-token time, so the whole step is used; the figure reads low"
		};

		// #region breakpoints

		/** Live matchMedia subscription; the pill shortens itself instead of relying on CSS. */
		function useMediaQuery(query) {
			var subscribe = react.useCallback(function (onChange) {
				var mql = window.matchMedia(query);
				mql.addEventListener("change", onChange);
				return function () {
					mql.removeEventListener("change", onChange);
				};
			}, [query]);
			var getSnapshot = react.useCallback(function () {
				return window.matchMedia(query).matches;
			}, [query]);
			return react.useSyncExternalStore(subscribe, getSnapshot, function () {
				return false;
			});
		}

		// #endregion

		// #region turn reading (window fallback)

		/**
		 * Visit every node of a snapshot node collection, whatever shape it takes.
		 *
		 * The collection is not necessarily a Map: `values()` may return a real
		 * iterator OR a materialized array depending on the assembly.
		 * @param collection - the snapshot's node collection.
		 * @param visit - receiver for each node value.
		 */
		function forEachSnapshotNode(collection, visit) {
			if (collection === null || collection === undefined || typeof collection !== "object") return;
			if (typeof collection.get === "function" && typeof collection.forEach === "function") {
				collection.forEach(function (value) {
					visit(value);
				});
				return;
			}
			var produced = null;
			if (typeof collection.values === "function") produced = collection.values();
			if (produced !== null && produced !== undefined && typeof produced.next === "function") {
				for (var next = produced.next(); next.done !== true; next = produced.next()) visit(next.value);
				return;
			}
			var list = produced;
			if (list === null || list === undefined) list = typeof collection.forEach === "function" ? null : collection;
			if (list !== null && list !== undefined && typeof list === "object" && typeof list[Symbol.iterator] === "function") {
				var items = Array.from(list);
				for (var index = 0; index < items.length; index += 1) {
					var item = items[index];
					visit(Array.isArray(item) && item.length === 2 ? item[1] : item);
				}
				return;
			}
			if (typeof collection.forEach === "function") {
				collection.forEach(function (value) {
					visit(value);
				});
				return;
			}
			var keys = Object.keys(collection);
			for (var k = 0; k < keys.length; k += 1) {
				var value = collection[keys[k]];
				if (value !== null && typeof value === "object") visit(value);
			}
		}

		/**
		 * Resolve the owning turn of one closing assistant message.
		 * @param snapshot - the live chat snapshot.
		 * @param messageId - the closing assistant message the row belongs to.
		 * @returns the owning turn number, or null when it is not in the window.
		 */
		function resolveTurn(snapshot, messageId) {
			if (snapshot === null || typeof snapshot !== "object") return null;
			var found = null;
			forEachSnapshotNode(snapshot.nodes, function (node) {
				if (found !== null) return;
				if (node === null || typeof node !== "object" || node.kind !== "turn-tail") return;
				var data = node.data;
				if (data === null || typeof data !== "object") return;
				var closing = data.closing;
				if (closing === null || typeof closing !== "object") return;
				var finalNode = closing.finalNode;
				if (finalNode === null || typeof finalNode !== "object") return;
				if (finalNode.messageId === messageId) found = data.turn;
			});
			return found;
		}

		/** The first token's timestamp inside one durable compact stream. */
		function firstDeltaTime(record) {
			var stream = record === null || typeof record !== "object" ? undefined : record.stream;
			if (!Array.isArray(stream)) return null;
			for (var index = 0; index < stream.length; index += 1) {
				var member = stream[index];
				if (member === null || typeof member !== "object") continue;
				if (member.type === "chunk") {
					if (!isTokenChunk(member.chunk)) continue;
					if (typeof member.time === "number" && Number.isFinite(member.time)) return member.time;
					continue;
				}
				var texts = member.type === "tool-call-chunks" ? member.args : member.texts;
				if (!Array.isArray(texts) || texts.length === 0) continue;
				if (typeof member.time0 === "number" && Number.isFinite(member.time0)) return member.time0;
			}
			return null;
		}

		/** Whether one stream chunk carries generated content. */
		function isTokenChunk(chunk) {
			if (chunk === null || typeof chunk !== "object") return false;
			switch (chunk.type) {
				case "text-delta":
				case "reasoning-delta":
					return chunk.text !== "";
				case "tool-call-delta":
					return chunk.argumentsDelta !== "" || chunk.name !== undefined;
				default:
					return false;
			}
		}

		/**
		 * One assistant step's latency facts; every absent value is null.
		 * @param node - a settled assistant record.
		 * @returns TTFT, decode wall time, whole-step span, and output tokens.
		 */
		function readStep(node) {
			var timing = node === null || typeof node !== "object" ? undefined : node.timing;
			var usage = node === null || typeof node !== "object" ? undefined : node.usage;
			var outputTokens = null;
			if (usage !== null && typeof usage === "object") {
				var raw = usage.outputTokens;
				if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) outputTokens = raw;
			}
			var ttftMs = null;
			var decodeMs = null;
			var first = null;
			var start = null;
			var done = null;
			if (timing !== null && typeof timing === "object") {
				start = typeof timing.stepStartTime === "number" ? timing.stepStartTime : null;
				first = typeof timing.firstTokenTime === "number" ? timing.firstTokenTime : null;
				done = typeof timing.completedTime === "number" ? timing.completedTime : null;
			}
			// A replayed turn carries no live-chunk timing, but its durable stream
			// still holds every delta boundary.
			if (first === null) first = firstDeltaTime(node);
			if (start !== null && first !== null) ttftMs = Math.max(0, first - start);
			if (first !== null && done !== null) decodeMs = Math.max(0, done - first);
			var spanMs = start !== null && done !== null ? Math.max(0, done - start) : null;
			return { ttftMs: ttftMs, decodeMs: decodeMs, spanMs: spanMs, outputTokens: outputTokens };
		}

		/** Collect assistant records of one turn from the loaded window. */
		function stepsForTurn(snapshot, turn, legacyNodes) {
			if (typeof turn !== "number") return [];
			if (snapshot !== null && typeof snapshot === "object") {
				var finals = [];
				forEachSnapshotNode(snapshot.nodes, function (view) {
					if (view === null || typeof view !== "object") return;
					if (view.kind !== "assistant-step" && view.kind !== "assistant") return;
					var data = view.data;
					if (data === null || typeof data !== "object" || data.turn !== turn) return;
					var finalNode = data.finalNode;
					if (finalNode === null || typeof finalNode !== "object") return;
					finals.push(finalNode);
				});
				if (finals.length > 0) return finals;
			}
			if (!Array.isArray(legacyNodes)) return [];
			var steps = [];
			for (var scan = 0; scan < legacyNodes.length; scan += 1) {
				var node = legacyNodes[scan];
				if (node === null || typeof node !== "object") continue;
				if (node.kind !== "assistant" || node.turn !== turn) continue;
				steps.push(node);
			}
			return steps;
		}

		/**
		 * Fold one turn's assistant records into the display reading.
		 * @param nodes - assistant records of the turn.
		 * @param turn - the owning turn.
		 * @returns the reading, or null when nothing usable is present.
		 */
		function turnReading(nodes, turn) {
			if (!Array.isArray(nodes) || typeof turn !== "number") return null;
			var steps = [];
			for (var scan = 0; scan < nodes.length; scan += 1) {
				var node = nodes[scan];
				if (node === null || typeof node !== "object") continue;
				if (node.kind !== "assistant" || node.turn !== turn) continue;
				steps.push(node);
			}
			if (steps.length === 0) return null;
			steps.sort(function (left, right) {
				return (typeof left.seq === "number" ? left.seq : 0) - (typeof right.seq === "number" ? right.seq : 0);
			});
			var ttftValues = [];
			var decodeTotal = 0;
			var tokenTotal = 0;
			var spanTotal = 0;
			var spanTokens = 0;
			for (var step = 0; step < steps.length; step += 1) {
				var reading = readStep(steps[step]);
				if (reading.ttftMs !== null) ttftValues.push(reading.ttftMs);
				if (reading.outputTokens !== null) {
					if (reading.decodeMs !== null) {
						decodeTotal += reading.decodeMs;
						tokenTotal += reading.outputTokens;
					}
					if (reading.spanMs !== null) {
						spanTotal += reading.spanMs;
						spanTokens += reading.outputTokens;
					}
				}
			}
			var firstStep = readStep(steps[0]);
			var ttftFirst = firstStep.ttftMs !== null ? firstStep.ttftMs : ttftValues.length > 0 ? ttftValues[0] : null;
			var ttftAvg = null;
			if (ttftValues.length > 0) {
				var sum = 0;
				for (var add = 0; add < ttftValues.length; add += 1) sum += ttftValues[add];
				ttftAvg = sum / ttftValues.length;
			}
			var tps = decodeTotal > 0 && tokenTotal > 0 ? tokenTotal / (decodeTotal / 1000) : null;
			var exact = tps !== null;
			if (!exact && spanTotal > 0 && spanTokens > 0) tps = spanTokens / (spanTotal / 1000);
			if (ttftFirst === null && tps === null) return null;
			return { ttftFirst: ttftFirst, ttftAvg: ttftAvg, tps: tps, exact: exact, steps: steps.length };
		}

		// #endregion

		// #region formatting

		/**
		 * Compact duration: one decimal under ten seconds, then whole seconds,
		 * then minutes.
		 * @param ms - duration in milliseconds.
		 * @returns display string.
		 */
		function formatMs(ms) {
			var seconds = ms / 1000;
			if (seconds < 9.95) return seconds.toFixed(1) + "s";
			var whole = Math.round(seconds);
			if (whole < 60) return whole + "s";
			var minutes = Math.floor(whole / 60);
			var rest = whole - minutes * 60;
			return minutes + "m" + (rest === 0 ? "" : rest + "s");
		}

		/**
		 * One decimal below 100 tokens per second, whole numbers above it.
		 * @param tps - tokens per second.
		 * @returns display string.
		 */
		function formatTps(tps) {
			return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
		}

		// #endregion


		// #region live rate

		/**
		 * Estimate streaming speed from the partial assistant text.
		 *
		 * The client receives delta text, not token counts, so characters stand in
		 * for tokens. That ratio is stable within one model and language, which is
		 * what a live readout needs; the durable per-turn figure stays exact.
		 * @param partial - the streaming assistant snapshot, or null when idle.
		 * @returns character count plus turn identity, or null when nothing streams.
		 */
		function liveChars(partial) {
			if (partial === null || partial === undefined) return null;
			var blocks = partial.blocks;
			if (!Array.isArray(blocks)) return null;
			var chars = 0;
			var visible = 0;
			for (var index = 0; index < blocks.length; index += 1) {
				var block = blocks[index];
				if (block === null || typeof block !== "object") continue;
				if (block.kind !== "text" && block.kind !== "reasoning") continue;
				if (typeof block.text !== "string") continue;
				chars += block.text.length;
				visible += block.text.length;
			}
			if (visible === 0) return null;
			return { chars: chars, turn: partial.turn, step: partial.step };
		}

		/**
		 * Sliding-window rate over successive character counts.
		 *
		 * A whole-turn average would hide a slow stretch, so the window keeps only
		 * the last second; the count resets when the turn or step changes, and the
		 * readout goes away once output stops.
		 */
		function createLiveSampler() {
			var samples = [];
			var identity = null;
			var text = null;
			return {
				/**
				 * Fold one observation in.
				 * @param measurement - character count and turn identity, or null when idle.
				 * @param now - observation time in ms.
				 */
				observe: function (measurement, now) {
					if (measurement === null) {
						samples.length = 0;
						identity = null;
						text = null;
						return;
					}
					var changed = identity === null || identity.turn !== measurement.turn || identity.step !== measurement.step || measurement.chars < identity.chars;
					if (changed) {
						samples.length = 0;
						identity = { turn: measurement.turn, step: measurement.step, chars: measurement.chars };
						samples.push({ at: now, chars: measurement.chars });
						text = null;
						return;
					}
					identity.chars = measurement.chars;
					samples.push({ at: now, chars: measurement.chars });
					while (samples.length > 2 && now - samples[0].at > LIVE_RATE_WINDOW_MS) samples.shift();
					var oldest = samples[0];
					var seconds = (now - oldest.at) / 1000;
					var grown = measurement.chars - oldest.chars;
					if (seconds < LIVE_RATE_MIN_SECONDS || grown <= 0) {
						text = null;
						return;
					}
					text = formatTps(grown / seconds) + " 字/s";
				},
				/** @returns the current readout text, or null when it should stay hidden. */
				read: function () {
					return text;
				}
			};
		}

		/**
		 * Publisher for the live chip: writes the sampled text into a sibling node
		 * beside the built-in running indicator.
		 *
		 * The indicator is Chat-internal with no slot, so this owns one chip element
		 * and keeps it attached while the indicator exists. The chip goes away with
		 * the indicator, which is exactly when a turn ends.
		 */
		function createLiveChip() {
			var chip = null;
			var host = null;
			var attach = function () {
				if (typeof document === "undefined") return;
				var running = document.querySelector("[data-chat-running]");
				if (running !== host) {
					host = running;
					if (host === null) {
						if (chip !== null && chip.parentElement !== null) chip.remove();
						return;
					}
					if (chip === null) {
						chip = document.createElement("span");
						chip.className = "dsh-simple-tps-live";
						chip.setAttribute("data-simple-tps-live", "");
					}
					if (chip.parentElement !== host) host.appendChild(chip);
				}
			};
			return {
				/** @param text - readout to show, or null to hide the chip. */
				publish: function (text) {
					attach();
					if (chip === null) return;
					if (text === null) {
						chip.textContent = "";
						chip.style.display = "none";
						return;
					}
					chip.style.display = "";
					chip.textContent = text;
				},
				/** @returns the teardown that removes the chip. */
				dispose: function () {
					if (chip !== null) chip.remove();
					chip = null;
					host = null;
				}
			};
		}

		/**
		 * Ambient session entry: samples the streaming assistant and publishes the
		 * live rate. Renders nothing — its whole output is the DOM chip.
		 * @returns the null render.
		 */
		function LiveRateSource(props) {
			var useChat = props === null || typeof props !== "object" ? undefined : props.useChat;
			var partial = typeof useChat === "function"
				? useChat(function (snapshot) {
						return snapshot.legacy === undefined ? null : snapshot.legacy.partial;
					})
				: null;
			var sampler = react.useRef(null);
			var chip = react.useRef(null);
			if (sampler.current === null) sampler.current = createLiveSampler();
			if (chip.current === null) chip.current = createLiveChip();
			react.useEffect(function () {
				var ticker = window.setInterval(function () {
					sampler.current.observe(liveChars(partial), Date.now());
					chip.current.publish(sampler.current.read());
				}, LIVE_RATE_INTERVAL_MS);
				return function () {
					window.clearInterval(ticker);
					chip.current.dispose();
				};
			}, []);
			react.useEffect(function () {
				// A new partial wakes the sampler immediately instead of waiting a tick.
				sampler.current.observe(liveChars(partial), Date.now());
				chip.current.publish(sampler.current.read());
			}, [partial]);
			return null;
		}

		// #endregion

		// #region dialog seat

		/** Sampling period for the live rate, matching the running clock's cadence. */
		var LIVE_RATE_INTERVAL_MS = 500;
		/** Sliding window the live rate averages over; short enough to feel current. */
		var LIVE_RATE_WINDOW_MS = 1200;
		/** Minimum span before a rate is meaningful; below it the chip stays hidden. */
		var LIVE_RATE_MIN_SECONDS = 0.35;

		/** Viewport margin the placement clamp keeps. */
		var PANEL_MARGIN = 12;
		/** Distance between the trigger's top edge and the panel's bottom. */
		var PANEL_GAP = 8;
		/** Unplaced panel style: laid out but invisible while the clamp measures it. */
		var MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };

		/**
		 * One trigger-anchored dialog seat: open state, clamped placement, dismissal.
		 *
		 * Reuses the harness primitives when present so placement and dismissal
		 * behave exactly like the shipped usage dialog; otherwise falls back to a
		 * plain fixed position and Escape handling.
		 * @returns the seat, with `pos` to spread onto the portaled panel.
		 */
		function useStatDialog() {
			var openState = react.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var rootRef = react.useRef(null);
			var panelRef = react.useRef(null);
			var anchored = typeof useAnchoredPosition === "function"
				? useAnchoredPosition({ open: open, anchorRef: rootRef, panelRef: panelRef, side: "top", gap: PANEL_GAP, margin: PANEL_MARGIN })
				: null;
			if (typeof useDismissOnOutsidePointer === "function") useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
			react.useEffect(function () {
				if (!open) return;
				var onKeyDown = function (event) {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return function () {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open, setOpen]);
			return { open: open, setOpen: setOpen, rootRef: rootRef, panelRef: panelRef, pos: anchored };
		}

		// #endregion

		// #region render

		// Diagnostic build: a failed lookup or a thrown render renders a red probe
		// instead of nothing, so one refresh pinpoints the failing layer.
		var DEBUG = false;

		/** Red diagnostic pill; every field is optional evidence for the next step. */
		function probe(message) {
			return react.createElement("span", { className: "dsh-simple-tps", "data-simple-tps": "debug", title: message, style: { color: "#e5484d", maxWidth: "46ch" } }, message);
		}

		/** Selector over the host projection: the whole per-turn map, or nothing. */
		function turnsOf(value) {
			return value === null || value === undefined ? null : value.turns ?? null;
		}

		/** One `<dt>`/`<dd>` pair in the details grid. */
		function detailRow(key, label, value) {
			return react.createElement(react.Fragment, { key: key }, react.createElement("dt", null, label), react.createElement("dd", null, value));
		}

		/** The details dialog: same recipe as the shipped turn-usage panel. */
		function DetailsPanel(props) {
			var t = props.t;
			var seat = props.seat;
			var reading = props.reading;
			return reactDom.createPortal(
				react.createElement(
					"div",
					{
						ref: seat.panelRef,
						className: "dsh-simple-tps-panel",
						role: "dialog",
						"aria-label": t("dialog.title"),
						style: seat.pos ?? MEASURE_STYLE,
						"data-simple-tps-dialog": ""
					},
					react.createElement(
						"div",
						{ className: "dsh-simple-tps-title" },
						react.createElement(
							"span",
							{ className: "dsh-simple-tps-titleLabel" },
							GaugeIcon === undefined ? null : react.createElement(GaugeIcon, { key: "icon" }),
							t("dialog.title")
						),
						react.createElement("span", { className: "dsh-simple-tps-titleValue" }, reading.tps === null ? "—" : formatTps(reading.tps) + " tok/s")
					),
					react.createElement("div", { className: "dsh-simple-tps-titleRule", "aria-hidden": true }),
					react.createElement(
						"dl",
						{ className: "dsh-simple-tps-details" },
						reading.ttftFirst === null ? null : detailRow("first", t("dialog.first"), formatMs(reading.ttftFirst)),
						reading.ttftAvg === null || reading.steps <= 1 ? null : detailRow("avg", t("dialog.avg"), formatMs(reading.ttftAvg)),
						detailRow("speed", t("dialog.speed"), reading.tps === null ? "—" : formatTps(reading.tps) + " tok/s"),
						detailRow("steps", t("dialog.steps"), String(reading.steps)),
						detailRow("window", reading.exact ? t("dialog.exact") : t("dialog.gross"), reading.exact ? t("dialog.hint.exact") : t("dialog.hint.gross"))
					)
				),
				document.body
			);
		}

		/** Assistant-actions entry: the throughput pill and its details dialog. */
		function Readout(props) {
			var narrowest = useMediaQuery("(max-width: 640px)");
			var hidden = useMediaQuery("(max-width: 480px)");
			var useChat = props === null || typeof props !== "object" ? undefined : props.useChat;
			var useProjection = props === null || typeof props !== "object" ? undefined : props.useProjection;
			var t = props === null || typeof props !== "object" ? undefined : props.t;
			var messageId = props === null || typeof props !== "object" ? undefined : props.messageId;
			var phrase = typeof t === "function" ? t : function (key) {
				return key;
			};
			var seat = useStatDialog();
			// Hooks must run unconditionally, so both seats are read every render and
			// the projection is merely preferred below.
			var projected = typeof useProjection === "function" ? useProjection("turnTimings", turnsOf) : null;
			var resolvedTurn = typeof useChat === "function"
				? useChat(function (snapshot) {
						return resolveTurn(snapshot, messageId);
					})
				: null;
			var reading = null;
			var entry = projected === null || projected === undefined || resolvedTurn === null ? undefined : projected[String(resolvedTurn)];
			if (entry !== undefined) {
				reading = entry;
			} else if (typeof useChat === "function") {
				// Projection absent (older host) or not projected yet: fold the window.
				try {
					var snapshot = useChat(function (value) {
						return value;
					});
					var legacyNodes = snapshot !== null && snapshot !== undefined && snapshot.legacy !== undefined ? snapshot.legacy.nodes : null;
					reading = turnReading(stepsForTurn(snapshot, resolvedTurn, legacyNodes), resolvedTurn);
				} catch (error) {
					return probe("DBG useChat " + String(error && error.message));
				}
			}
			if (reading === null || reading === undefined) {
				if (!DEBUG) return null;
				return probe("DBG no-reading t" + (resolvedTurn === null ? "-" : resolvedTurn));
			}
			if (hidden) return null;
			try {
				var label = reading.exact ? phrase("tps", { value: formatTps(reading.tps) }) : phrase("tps.gross", { value: formatTps(reading.tps) });
				if (reading.tps === null) label = phrase("dialog.speed") + " —";
				return react.createElement(
					"span",
					{ className: "dsh-simple-tps-root", ref: seat.rootRef },
					react.createElement(
						"button",
						{
							type: "button",
							className: "dsh-simple-tps-trigger",
							"aria-haspopup": "dialog",
							"aria-expanded": seat.open,
							"data-simple-tps": reading.exact ? "exact" : "gross",
							title: reading.exact ? label : phrase("tps.grossHint"),
							onClick: function () {
								seat.setOpen(!seat.open);
							}
						},
						GaugeIcon === undefined ? null : react.createElement(GaugeIcon, { key: "icon" }),
						narrowest ? null : react.createElement("span", { className: "dsh-simple-tps-label", key: "label" }, label)
					),
					seat.open ? react.createElement(DetailsPanel, { key: "panel", t: phrase, seat: seat, reading: reading }) : null
				);
			} catch (error) {
				return probe("DBG render " + String(error && error.message));
			}
		}

		// #endregion

		// Mirrors the shipped usage pill and stat dialog: same tokens, same metrics.
		var css =
			".dsh-simple-tps-root{min-width:0;display:inline-flex}" +
			".dsh-simple-tps-trigger{min-width:0;height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(24px + var(--dsh-content-font-delta,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:6px 8px;display:inline-flex}" +
			".dsh-simple-tps-label{text-overflow:ellipsis;min-width:0;overflow:hidden}" +
			".dsh-simple-tps-trigger svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}" +
			".dsh-simple-tps-trigger:hover,.dsh-simple-tps-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}" +
			"@media (width<=480px){.dsh-simple-tps-trigger{width:calc(28px + var(--dsh-content-font-delta,0px));justify-content:center;padding:6px}.dsh-simple-tps-trigger .dsh-simple-tps-label{display:none}}" +
			".dsh-simple-tps-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}" +
			".dsh-simple-tps-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}" +
			".dsh-simple-tps-titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}" +
			".dsh-simple-tps-titleValue{font-variant-numeric:tabular-nums}" +
			".dsh-simple-tps-titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}" +
			".dsh-simple-tps-titleLabel svg{flex:none;width:14px;height:14px}" +
			".dsh-simple-tps-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}" +
			".dsh-simple-tps-details dt,.dsh-simple-tps-details dd{min-width:0;margin:0}" +
			".dsh-simple-tps-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}" +
			// Seat the pill after the branch button, before the usage pill. A descendant
			// selector is required: a display:contents slot wrapper sits in between.
			//
			// Both sides keep the row's own 8px gap. The usage group carries an extra
			// 8px margin-left of its own, so the pill cancels exactly that much on its
			// right; a matching left margin would double the left side to 16px.
			".dsh-simple-tps-live{color:inherit;font-size:inherit;line-height:inherit;font-variant-numeric:tabular-nums;opacity:.85;margin-left:8px}" +
			"[data-clock=end] .dsh-simple-tps-root{margin-right:-8px;order:5}" +
			"[data-clock=end]>:last-child{order:10}";

		/** Install the readout stylesheet once per document. */
		function mountStyle() {
			if (typeof document === "undefined") return function () {};
			if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return function () {};
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-simple-tps";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
			return function () {
				tag.remove();
			};
		}

		var inject = ["slots", "locale"];

		/**
		 * Register the per-turn throughput pill beside the built-in usage pill.
		 * @param ctx - the client plugin context.
		 */
		function apply(ctx) {
			ctx.effect(mountStyle, "simple-tps: styles");
			ctx.effect(function () {
				return ctx.slots.inject("conversation.composer.dock", function () {
					return ctx.slots.register({
						name: "conversation.composer.dock",
						id: "simple-tps-live",
						order: 900,
						locale: NS
					}, LiveRateSource);
				});
			}, "simple-tps: live rate");
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "simple-tps: dictionaries");
			ctx.effect(function () {
				return ctx.slots.inject("conversation.chat.assistant-actions", function () {
					return ctx.slots.register({
						name: "conversation.chat.assistant-actions",
						id: "simple-tps",
						order: 100,
						locale: NS
					}, Readout);
				});
			}, "simple-tps: turn readout");
		}

		exports.apply = apply;
		/** Test seam: toggle the diagnostic build without rebuilding. */
		exports.setDebug = function (value) {
			DEBUG = value === true;
		};
		exports.inject = inject;
		exports.liveChars = liveChars;
		exports.createLiveSampler = createLiveSampler;
		exports.formatMs = formatMs;
		exports.formatTps = formatTps;
		exports.turnReading = turnReading;
		exports.resolveTurn = resolveTurn;
		exports.stepsForTurn = stepsForTurn;
		exports.firstDeltaTime = firstDeltaTime;
		exports.forEachSnapshotNode = forEachSnapshotNode;
		return module.exports;
	}
});
