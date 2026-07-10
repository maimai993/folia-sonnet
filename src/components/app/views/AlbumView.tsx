import React from 'react';
import LegacyAlbumView from '../../AlbumView';

// @deprecated Kept solely for search-result navigation until the legacy list view is removed.
const AlbumView: React.FC<React.ComponentProps<typeof LegacyAlbumView>> = (props) => {
    return <LegacyAlbumView {...props} />;
};

export default AlbumView;
