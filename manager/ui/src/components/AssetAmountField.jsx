import { useId } from 'react';
import {
	MAX_UNITS,
	SLIDER_STEPS,
	decimalsOf,
	fmtUnits,
	fromRatio,
	parseAmountInput,
	ratio,
	toUnits,
	unitOf,
	unitsToInput
} from '../lib/asset-amount.js';

/**
 * Amount entry for an asset: the sats field's shell (AmountField in ui.jsx),
 * counting in the asset's own units.
 *
 * `value` is the text in the box and `onChange(text, units)` hands back both
 * the text and the amount it stands for, as a decimal string of base units
 * (null while the box holds no amount). The caller keeps both: the text so a
 * half typed "12." survives a render, the units to send.
 *
 * A keystroke the asset cannot represent is not accepted: a letter, or a
 * digit past its decimal places. Refusing it at the keyboard is kinder than
 * accepting it and rounding, and the hint under the field says how many
 * places there are.
 *
 * With `max` (base units) the slider and the Max button appear; without it
 * the field is the box alone, which is what creating and receiving want.
 * `showUnits` adds the line that says what the figure is on the network, and
 * `refusal` is the caller's reason the amount will not do, said under the box.
 */
export default function AssetAmountField({
	label,
	asset,
	value,
	onChange,
	max,
	isMax,
	onMax,
	disabled,
	hint,
	refusal,
	showUnits = false,
	placeholder,
	testId
}) {
	const id = useId();
	const decimals = decimalsOf(asset);
	const parsed = parseAmountInput(value, decimals);
	const ceiling = max === undefined || max === null ? null : toUnits(max) ?? 0n;
	const bounded = ceiling !== null;
	const usable = !disabled && bounded && ceiling > 0n;
	const position = bounded && parsed.units ? ratio(parsed.units, ceiling) : 0;
	const pct = Math.round((position / SLIDER_STEPS) * 100);

	const type = (text) => {
		const next = parseAmountInput(text, decimals);
		// Not an amount this asset can have, so the box keeps what it held.
		if (next.error === 'NOT_A_NUMBER' || next.error === 'PRECISION') return;
		onChange(next.text, next.units);
	};

	return (
		<div className="field">
			{label && (
				<label className="field-label" htmlFor={id}>
					{label}
				</label>
			)}
			<div className="amount-row">
				<input
					id={id}
					className="amount-input"
					inputMode={decimals > 0 ? 'decimal' : 'numeric'}
					autoComplete="off"
					value={value}
					disabled={disabled}
					placeholder={placeholder}
					data-testid={testId}
					onChange={(e) => type(e.target.value)}
				/>
				<span className="amount-unit">{unitOf(asset)}</span>
				{bounded && (
					<button
						type="button"
						className={`btn sm ${isMax ? 'primary' : ''}`}
						onClick={onMax}
						disabled={!usable}
						aria-pressed={!!isMax}
					>
						Max
					</button>
				)}
			</div>
			{bounded && (
				<>
					<input
						type="range"
						className="amount-slider"
						aria-label={label ? `${label} slider` : 'Amount slider'}
						min={0}
						max={SLIDER_STEPS}
						step={1}
						value={position}
						disabled={!usable}
						onChange={(e) => {
							const units = fromRatio(e.target.value, ceiling);
							onChange(units === '0' ? '' : unitsToInput(units, decimals), units === '0' ? null : units);
						}}
					/>
					<div className="amount-scale">
						<span>0</span>
						<span>{pct}%</span>
						<span>{ceiling > 0n ? fmtUnits(ceiling, decimals) : '-'}</span>
					</div>
				</>
			)}
			{parsed.error === 'TOO_LARGE' && (
				<span className="field-hint refusal" role="alert">
					That is more than an asset can hold ({fmtUnits(MAX_UNITS, 0)} units).
				</span>
			)}
			{showUnits && decimals > 0 && parsed.units && (
				<span className="field-hint" data-testid={testId ? `${testId}-units` : undefined}>
					= {fmtUnits(parsed.units, 0)} units on the network
				</span>
			)}
			{refusal && (
				<span className="field-hint refusal" role="alert" data-testid={testId ? `${testId}-refusal` : undefined}>
					{refusal}
				</span>
			)}
			{hint && <span className="field-hint">{hint}</span>}
		</div>
	);
}
