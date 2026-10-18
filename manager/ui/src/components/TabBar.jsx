import { NavLink } from 'react-router-dom';
import { m } from 'motion/react';
import { springs } from '../lib/motion.js';

/**
 * The wallet's screens in a row. `items` is [key, label, Component, dev?][];
 * developer screens sit after a divider in a quieter weight. `active` is the
 * key under the underline, or null when the screen showing is not in the bar
 * (Send and Receive live on the hero's buttons).
 */
export default function TabBar({ id, items, active, rawApi = true, end = null }) {
	let dividerDrawn = false;
	return (
		<nav className="tabbar" aria-label="Wallet sections">
			{items.map(([key, label, , dev]) => {
				const divider = dev && !dividerDrawn;
				if (divider) dividerDrawn = true;
				return (
					<span key={key} style={{ display: 'contents' }}>
						{divider && <span className="tabbar-divider" aria-hidden="true" />}
						<NavLink
							to={`/w/${id}/${key}`}
							className={`${key === active ? 'active' : ''} ${dev ? 'dev' : ''}`}
							aria-current={key === active ? 'page' : undefined}
						>
							{key === active && (
								<m.span layoutId="wnav-indicator" className="tabbar-indicator" transition={springs.snappy} />
							)}
							{label}
						</NavLink>
					</span>
				);
			})}
			{rawApi && (
				<a className="dev" href={`/swagger.html?id=${id}`} target="_blank" rel="noreferrer">
					Raw API ↗
				</a>
			)}
			{end && <span className="tabbar-end">{end}</span>}
		</nav>
	);
}
