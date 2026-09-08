import { LatticeTitle } from '../../src/components/app/lattice/LatticeTitle';
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
function Poster({ title, expanded, metadata }: { title: string; expanded: boolean; metadata?: boolean }) {
    return <div
        className={`lattice-poster${expanded ? ' is-expanded' : ''}`}
        style={{ position: 'relative', width: expanded ? 494 : 300, height: expanded ? 440 : 300, background: '#243748' }}
    >
        <span className={`lattice-poster-copy${metadata ? ' lattice-lyric-metadata' : ''}`}>
            {metadata ? <strong>{title}</strong> : <LatticeTitle title={title} expanded={expanded} />}<small>HOYO-MiX</small>
        </span>
    </div>;
}

// Isolated mixed-font titles at the compact line spacing posters use. The third title of each
// group runs past the three-line cap, which is where the fourth line used to leak.
function LatticeTitleProbe() {
    return <div className="lattice-root" style={{ color: 'white', background: '#243748', padding: 40, display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {TITLES.map(title => <Poster key={title} title={title} expanded />)}
        {TITLES.map(title => <Poster key={`compact-${title}`} title={title} expanded={false} />)}
        {/* Lyric mode drops the same title to a single truncated line. */}
        <Poster key="metadata" title={TITLES[2]} expanded metadata />
        <style>{'.lattice-poster.is-expanded .lattice-poster-copy:not(.lattice-lyric-metadata) strong { font-size: 70.7625px; }'}</style>
    </div>;
}

export default {
    id: 'latticeTitle', title: 'Lattice title clipping',
    description: 'Mixed CJK and Latin glyphs, tight line spacing and three-line truncation.',
    Component: LatticeTitleProbe,
} satisfies ProbeDefinition;
