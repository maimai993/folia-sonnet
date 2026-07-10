import React from 'react';
import LegacyArtistView from '../../ArtistView';

// @deprecated Kept solely for search-result navigation until the legacy list view is removed.
const ArtistView: React.FC<React.ComponentProps<typeof LegacyArtistView>> = (props) => {
    return <LegacyArtistView {...props} />;
};

export default ArtistView;
