// Wires up the #starSearch box: queries search.php as the user types and
// renders clickable results (systems, constellations, regions) into
// #searchResults.
(function () {

    var input = document.getElementById( 'starSearch' );
    var results = document.getElementById( 'searchResults' );
    var timer = null;
    var currentXhr = null;

    function typeLabel( type ) {
        if ( type === 'system' ) return 'System';
        if ( type === 'constellation' ) return 'Constellation';
        if ( type === 'region' ) return 'Region';
        return type;
    }

    function linkFor( item ) {
        if ( item.type === 'system' ) {
            return 'system.php?system=' + item.id;
        }
        if ( item.type === 'constellation' ) {
            return 'constellation.php?constellation=' + item.id;
        }
        return 'region.php?region=' + item.id;
    }

    function render( items ) {
        results.textContent = '';

        if ( !items.length ) {
            results.style.display = 'none';
            return;
        }

        for ( var i = 0; i < items.length; i++ ) {
            var item = items[ i ];
            var url = linkFor( item );

            var row = document.createElement( 'div' );
            row.className = 'searchResultRow';

            var tag = document.createElement( 'span' );
            tag.className = 'searchResultType';
            tag.textContent = typeLabel( item.type );

            var name = document.createElement( 'span' );
            name.textContent = item.name;

            row.appendChild( tag );
            row.appendChild( name );
            row.addEventListener( 'click', ( function ( url ) {
                return function () { window.location = url; };
            } )( url ) );

            results.appendChild( row );
        }

        results.style.display = 'block';
    }

    input.addEventListener( 'input', function () {

        var q = input.value.trim();
        clearTimeout( timer );

        if ( q.length < 2 ) {
            results.style.display = 'none';
            return;
        }

        timer = setTimeout( function () {

            if ( currentXhr ) {
                currentXhr.abort();
            }

            currentXhr = new XMLHttpRequest();
            currentXhr.open( 'GET', 'search.php?q=' + encodeURIComponent( q ), true );
            currentXhr.onload = function () {
                if ( currentXhr.status === 200 ) {
                    render( JSON.parse( currentXhr.responseText ) );
                }
            };
            currentXhr.send();

        }, 200 );
    } );

    document.addEventListener( 'click', function ( e ) {
        if ( e.target !== input ) {
            results.style.display = 'none';
        }
    } );

} )();
