/* Inline icons. Stroke follows the text colour, nothing carries a title, so
   an icon never adds a word to the text a test or a screen reader sees. */

const PATHS = {
	send: ['M7 17L17 7', 'M8 7h9v9'],
	receive: ['M17 7L7 17', 'M16 17H7V8'],
	copy: ['M9 9.5h9a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 19v-8A1.5 1.5 0 0 1 9 9.5z', 'M15 9.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v7.5A1.5 1.5 0 0 0 6 15h1.5'],
	check: ['M5 12.5l4.5 4.5L19 7.5'],
	chevron: ['M9 6l6 6-6 6'],
	'chevron-down': ['M6 9l6 6 6-6'],
	more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
	settings: [
		'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
		'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'
	],
	sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'M4.93 4.93l1.41 1.41', 'M17.66 17.66l1.41 1.41', 'M2 12h2', 'M20 12h2', 'M4.93 19.07l1.41-1.41', 'M17.66 6.34l1.41-1.41'],
	moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z'],
	bolt: ['M13 2L4 14h7l-1 8 9-12h-7l1-8z'],
	chain: ['M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5', 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5'],
	close: ['M6 6l12 12', 'M18 6L6 18'],
	external: ['M14 4h6v6', 'M20 4l-9 9', 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5'],
	plus: ['M12 5v14', 'M5 12h14'],
	minus: ['M5 12h14'],
	info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8h.01'],
	alert: ['M12 3l10 18H2L12 3z', 'M12 10v4', 'M12 17h.01'],
	back: ['M19 12H5', 'M11 18l-6-6 6-6'],
	refresh: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'],
	play: ['M7 5v14l11-7z'],
	stop: ['M6 6h12v12H6z'],
	trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
	edit: ['M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z', 'M13.5 6.5l3 3'],
	wallet: ['M3 7a2 2 0 0 1 2-2h14v4', 'M3 7v10a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2z', 'M16 13h.01'],
	clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
	eye: ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z']
};

export function Icon({ name, size = 16, strokeWidth = 1.8, className = '', style }) {
	const paths = PATHS[name];
	if (!paths) return null;
	return (
		<svg
			className={className}
			style={style}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{paths.map((d) => (
				<path key={d} d={d} />
			))}
		</svg>
	);
}

export const ICON_NAMES = Object.keys(PATHS);
