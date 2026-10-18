import { useState } from 'react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { springs } from '../lib/motion.js';

/**
 * A section that opens and closes by height. Without `persist` the content
 * mounts on open and unmounts after the exit; with it the content stays in
 * the DOM (hidden from the accessibility tree) and only the height moves,
 * for forms whose fields must exist whether or not they are showing.
 *
 * Overflow is clipped only while the height is moving, so a focus ring on
 * the first or last control is not cut off once the section is open.
 */
export function Reveal({ open, children, persist = false, className = '', style, inner = 'reveal-inner' }) {
	const reduced = useReducedMotion();
	const [moving, setMoving] = useState(false);
	const transition = reduced
		? { duration: 0 }
		: { height: springs.gentle, opacity: { duration: 0.18 } };
	const overflow = open && !moving ? 'visible' : 'hidden';
	const handlers = {
		onAnimationStart: () => setMoving(true),
		onAnimationComplete: () => setMoving(false)
	};

	if (persist) {
		return (
			<m.div
				className={className}
				initial={false}
				animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
				transition={transition}
				style={{ overflow, ...style }}
				aria-hidden={open ? undefined : true}
				inert={open ? undefined : ''}
				{...handlers}
			>
				<div className={inner}>{children}</div>
			</m.div>
		);
	}

	return (
		<AnimatePresence initial={false}>
			{open && (
				<m.div
					key="reveal"
					className={className}
					initial={{ height: 0, opacity: 0 }}
					animate={{ height: 'auto', opacity: 1 }}
					exit={{ height: 0, opacity: 0 }}
					transition={transition}
					style={{ overflow, ...style }}
					{...handlers}
				>
					<div className={inner}>{children}</div>
				</m.div>
			)}
		</AnimatePresence>
	);
}

/**
 * Remounts its content with a short fade whenever `value` changes. Enter
 * only: the old view leaves at once, so a swap never shows an empty gap.
 */
export function Switch({ value, children, className = '', style }) {
	return (
		<m.div
			key={String(value)}
			className={className}
			style={style}
			initial={{ opacity: 0, y: 4 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.18, ease: 'easeOut' }}
		>
			{children}
		</m.div>
	);
}

/** A ring that spins. No text, so a busy button keeps its exact label. */
export function Spinner({ className = '' }) {
	return <span className={`spinner-ring ${className}`} aria-hidden="true" />;
}

/** A spinner with a word beside it, for a line that is waiting on something. */
export function SpinnerLine({ children, className = '', ...rest }) {
	return (
		<span className={`spinner-line ${className}`} {...rest}>
			<Spinner />
			<span>{children}</span>
		</span>
	);
}

/** A checkmark that draws itself, for the moment something succeeds. */
export function Check({ size = 56, className = '' }) {
	const reduced = useReducedMotion();
	const glyph = Math.round(size * 0.5);
	return (
		<span className={`check-mark ${className}`} style={{ width: size, height: size }} aria-hidden="true">
			<svg
				viewBox="0 0 24 24"
				width={glyph}
				height={glyph}
				fill="none"
				stroke="currentColor"
				strokeWidth="2.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<m.path
					d="M5 12.5l4.5 4.5L19 7.5"
					initial={reduced ? false : { pathLength: 0, opacity: 0 }}
					animate={{ pathLength: 1, opacity: 1 }}
					transition={{ duration: 0.45, ease: 'easeOut', delay: 0.08 }}
				/>
			</svg>
		</span>
	);
}
