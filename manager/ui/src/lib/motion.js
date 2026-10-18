/* Shared motion vocabulary. Springs for things that move, short eases for
   things that appear, and the variants the list staggers use. */

export const springs = {
	snappy: { type: 'spring', stiffness: 520, damping: 40 },
	gentle: { type: 'spring', stiffness: 300, damping: 30 },
	soft: { type: 'spring', stiffness: 170, damping: 26 }
};

export const ease = {
	out: [0.16, 1, 0.3, 1],
	standard: [0.2, 0.8, 0.2, 1]
};

export const durations = {
	fast: 0.15,
	med: 0.28,
	slow: 0.45
};

export const fade = {
	initial: { opacity: 0 },
	animate: { opacity: 1 },
	exit: { opacity: 0 },
	transition: { duration: durations.fast }
};

export const fadeUp = {
	initial: { opacity: 0, y: 8 },
	animate: { opacity: 1, y: 0 },
	exit: { opacity: 0, y: -4 },
	transition: { duration: 0.2, ease: ease.standard }
};

export const scaleIn = {
	initial: { opacity: 0, scale: 0.96 },
	animate: { opacity: 1, scale: 1 },
	exit: { opacity: 0, scale: 0.98 },
	transition: springs.snappy
};

export const staggerContainer = {
	hidden: {},
	show: { transition: { staggerChildren: 0.045 } }
};

export const staggerItem = {
	hidden: { opacity: 0, y: 10 },
	show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 380, damping: 34 } }
};
