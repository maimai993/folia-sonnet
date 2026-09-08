import { useMemo, useState } from 'react';
import { LatticeTitle } from '../../src/components/app/lattice/LatticeTitle';
import { TitleFitterContext } from '../../src/hooks/useSettledTitle';
import { fitTitle } from '../../src/utils/fitSettledTitle';
import type { ProbeDefinition } from './definition';
import '../../src/components/app/lattice/Lattice.css';
import '../../src/components/app/lattice/lyrics/LatticeLyrics.css';

const TITLES = [
    'Piano Sonata, Op. 27 No. 2, in C♯ minor, “Moonlight”',
    '壤土下的安居 Cozy Home Underground',
    '锤砧间的音符 Notes From Striking the Anvil',
    '新月的摇篮曲（其三）：眉间落英 Lullaby of the New Moon',
];

// The leading only resolves through the poster rules, so the probe mounts real posters
// instead of a bare copy block.
function Poster({ title, expanded, metadata, layoutSettled }: { title: string; expanded: boolean; metadata?: boolean; layoutSettled?: boolean }) {
    return <div
        className={`lattice-poster${expanded ? ' is-expanded' : ''}`}
        style={{ position: 'relative', width: expanded ? 494 : 300, height: expanded ? 440 : 300, background: '#243748' }}
    >
        <span className={`lattice-poster-copy${metadata ? ' lattice-lyric-metadata' : ''}`}>
            {metadata ? <strong>{title}</strong> : <LatticeTitle title={title} expanded={expanded} layoutSettled={layoutSettled} />}<small>HOYO-MiX</small>
        </span>
    </div>;
}

// Isolated mixed-font titles at the compact line spacing posters use. The third title of each
// group runs past the three-line cap, which is where the fourth line used to leak.
function LatticeTitleProbe() {
    // Remounting is how a panned-away poster comes back: its own observers and state are gone, so
    // only a cache outliving the component can spare the second measurement. The counter wraps the
    // production fitter rather than replacing it, so what is measured stays unchanged.
    const [generation, setGeneration] = useState(0);
    const [fits, setFits] = useState(0);
    // Stands in for an expanding poster telling the title its box has stopped growing.
    const [layoutSettled, setLayoutSettled] = useState(false);
    const fitter = useMemo(() => (node: HTMLElement, text: string, width?: string) => {
        setFits(value => value + 1);
        return fitTitle(node, text, { width });
    }, []);
    return <TitleFitterContext.Provider value={fitter}>
        <div className="lattice-root" data-fits={fits} style={{ color: 'white', background: '#243748', padding: 40 }}>
            <button type="button" onClick={() => setGeneration(value => value + 1)}>Remount titles</button>
            <label><input type="checkbox" checked={layoutSettled} onChange={event => setLayoutSettled(event.target.checked)} /> Layout settled</label>
            {/* Keeps the poster grid laid out exactly as before the remount control was added. */}
            <div key={generation} data-generation={generation} style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
                {TITLES.map(title => <Poster key={title} title={title} expanded layoutSettled={layoutSettled} />)}
                {TITLES.map(title => <Poster key={`compact-${title}`} title={title} expanded={false} layoutSettled={layoutSettled} />)}
                {/* Lyric mode drops the same title to a single truncated line. */}
                <Poster key="metadata" title={TITLES[2]} expanded metadata />
            </div>
            <style>{'.lattice-poster.is-expanded .lattice-poster-copy:not(.lattice-lyric-metadata) strong { font-size: 70.7625px; }'}</style>
        </div>
    </TitleFitterContext.Provider>;
}

export default {
    id: 'latticeTitle', title: 'Lattice title clipping',
    description: 'Mixed CJK and Latin glyphs, tight line spacing and three-line truncation.',
    Component: LatticeTitleProbe,
} satisfies ProbeDefinition;
