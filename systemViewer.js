// Renders a solar system's contents (star, planets, moons, belts, stations,
// stargates) using the same Three.js orbit-camera mechanics as viewer.js.
//
// The including page must define, before loading this file:
//   items - array of {id,x,y,z,name,type,orbitid,destSystemId}
//           type is an invGroups groupName ("Sun","Planet","Moon",
//           "Asteroid Belt","Station","Stargate", ...)
//           orbitid is the itemid of the body this one orbits, or null
//           destSystemId is set (non-null) only on Stargate items
//   currentSystemId - solarSystemID of the system currently on screen
//   currentPlanetId - itemid of the planet being drilled into (moon
//                     close-up view), or null for the whole-system view
//
// Orbit rings are drawn as circles at each Planet/Moon's actual current
// distance from its parent (we don't have real orbital-plane data, so this
// is a simple approximation, not a true Keplerian ellipse).
//
// Clicking a Stargate jumps to the system it leads to; clicking a Planet
// (only from the whole-system view) drills into a locally-rescaled view of
// just that planet and its moons, since a moon's real distance from its
// planet is usually far too small to show at whole-system scale.

var TYPE_STYLE = {
    'Sun':           { color: 0xffee88, size: 24, label: '#ffffaa', labelSize: 14 },
    'Secondary Sun': { color: 0xffee88, size: 20, label: '#ffffaa', labelSize: 14 },
    'Planet':        { color: 0x66ccff, size: 14, label: '#ffffff', labelSize: 12 },
    'Moon':          { color: 0x999999, size: 5,  label: '#888888', labelSize: 9 },
    'Station':       { color: 0x33ffcc, size: 3,  label: '#33ffcc', labelSize: 10 },
    'Stargate':      { color: 0xffaa33, size: 8,  label: '#ffaa33', labelSize: 10 },
    'Asteroid Belt': { color: 0xaa8855, size: 6,  label: '#aa8855', labelSize: 9 },
    'Ice Belt':      { color: 0xaad4ff, size: 6,  label: '#aad4ff', labelSize: 9 }
};
var DEFAULT_STYLE = { color: 0xcccccc, size: 6, label: '#aaaaaa', labelSize: 9 };

target = new THREE.Vector3( 0, 0, 0 );
arc = 0;
radius = 700;
var isMouseDown = false, onMouseDownPosition, theta = 45, onMouseDownTheta = 45, phi = 60, onMouseDownPhi = 60, isShiftDown = false;
var rotate = true;
var mouse = { x: 0, y: 0 };

var camera, scene, renderer, projector, particles = [];

init();

function init() {

    camera = new THREE.PerspectiveCamera( 80, window.innerWidth / window.innerHeight, 1, 4000 );
    camera.position.z = 700;
    camera.lookAt( target );

    scene = new THREE.Scene();
    scene.add( camera );

    renderer = new THREE.CanvasRenderer();
    renderer.setSize( window.innerWidth, window.innerHeight );
    document.body.appendChild( renderer.domElement );

    projector = new THREE.Projector();
    makeParticles();

    document.addEventListener( 'mousemove', onDocumentMouseMove, false );
    document.addEventListener( 'mousedown', onDocumentMouseDown, false );
    document.addEventListener( 'mouseup', onDocumentMouseUp, false );
    document.addEventListener( 'mousewheel', onDocumentMouseWheel, false );
    document.addEventListener( 'DOMMouseScroll', onDocumentMouseWheel, false );
    onMouseDownPosition = new THREE.Vector2();

    setInterval( update, 1000 / 30 );
    renderer.domElement.oncontextmenu = function () { return false; };
}

function update() {

    if ( rotate ) {
        arc = ( arc > 6.28 ) ? 0 : arc + 0.01;
        camera.position.x = target.x + Math.floor( Math.cos( arc ) * radius );
        camera.position.z = target.z + Math.floor( Math.sin( arc ) * radius );
    }

    camera.lookAt( target );
    renderer.render( scene, camera );
    updateLabels();
}

function updateLabels() {

    var halfWidth = window.innerWidth / 2, halfHeight = window.innerHeight / 2;

    for ( var i = 0; i < particles.length; i++ ) {
        var p = particles[ i ];
        var vector = p.position.clone();
        projector.projectVector( vector, camera );

        p.label.style.left = ( vector.x * halfWidth + halfWidth + 12 ) + "px";
        p.label.style.top = ( -vector.y * halfHeight + halfHeight - 6 ) + "px";
    }
}

function makeParticles() {

    var offset = 210;
    var sunPosition = null;
    var planetPosition = null;
    var positionById = {};

    for ( var i = 0; i < items.length; i++ ) {
        var item = items[ i ];
        var style = TYPE_STYLE[ item.type ] || DEFAULT_STYLE;

        var geometry = new THREE.SphereGeometry( style.size, 12, 12 );
        var particle = new THREE.Mesh( geometry, new THREE.MeshLambertMaterial( { color: style.color } ) );
        particle.position.x = item.x - offset;
        particle.position.y = item.y - offset;
        particle.position.z = item.z - offset;
        particle.name = item.name;
        particle.itemId = item.id;
        particle.itemType = item.type;
        particle.destSystemId = item.destSystemId;
        scene.add( particle );
        particles.push( particle );
        positionById[ item.id ] = particle.position;

        var label = document.createElement( 'div' );
        label.className = 'starLabel';
        label.style.color = style.label;
        label.style.fontSize = style.labelSize + 'px';
        label.textContent = item.name;
        document.body.appendChild( label );
        particle.label = label;

        if ( ( item.type === 'Sun' || item.type === 'Secondary Sun' ) && !sunPosition ) {
            sunPosition = particle.position;
        }
        if ( item.type === 'Planet' && !planetPosition ) {
            planetPosition = particle.position;
        }
    }

    if ( sunPosition || planetPosition ) {
        target.copy( sunPosition || planetPosition );
    }

    // stations render right at their real position, which is usually
    // close enough to their moon/planet to sit inside its sphere - nudge
    // them outward along the same direction so they're visibly separate
    var STATION_PUSH_OUT = 20;

    for ( var s = 0; s < items.length; s++ ) {
        var stationItem = items[ s ];

        if ( stationItem.type !== 'Station' || !stationItem.orbitid || !positionById[ stationItem.orbitid ] ) {
            continue;
        }

        var stationPos = positionById[ stationItem.id ];
        var parentPos = positionById[ stationItem.orbitid ];
        var away = new THREE.Vector3().sub( stationPos, parentPos );

        if ( away.length() < 0.001 ) {
            away.set( 1, 0, 0 );
        } else {
            away.normalize();
        }

        stationPos.x += away.x * STATION_PUSH_OUT;
        stationPos.y += away.y * STATION_PUSH_OUT;
        stationPos.z += away.z * STATION_PUSH_OUT;
    }

    var ORBIT_COLOR = { 'Planet': 0x336688, 'Moon': 0x444444 };

    for ( var j = 0; j < items.length; j++ ) {
        var orbiter = items[ j ];
        var ringColor = ORBIT_COLOR[ orbiter.type ];

        if ( !ringColor || !orbiter.orbitid || !positionById[ orbiter.orbitid ] ) {
            continue;
        }

        drawOrbitRing( positionById[ orbiter.orbitid ], positionById[ orbiter.id ], ringColor );
    }
}

// draws a circle, centered on parentPos, sized to the current distance
// between parentPos and childPos, guaranteed to pass through childPos
// (we don't know the real orbital plane, so the rest of the ring's tilt
// is a simple, arbitrary approximation)
function drawOrbitRing( parentPos, childPos, color ) {

    var toChild = new THREE.Vector3().sub( childPos, parentPos );
    var radius = toChild.length();

    if ( radius < 1 ) {
        return;
    }

    var u = toChild.clone().divideScalar( radius );
    var helper = ( Math.abs( u.y ) > 0.9 ) ? new THREE.Vector3( 1, 0, 0 ) : new THREE.Vector3( 0, 1, 0 );
    var v = new THREE.Vector3().cross( u, helper ).normalize();

    var segments = 64;
    var geometry = new THREE.Geometry();

    for ( var k = 0; k <= segments; k++ ) {
        var angle = ( k / segments ) * Math.PI * 2;
        var point = new THREE.Vector3(
            parentPos.x + ( u.x * Math.cos( angle ) + v.x * Math.sin( angle ) ) * radius,
            parentPos.y + ( u.y * Math.cos( angle ) + v.y * Math.sin( angle ) ) * radius,
            parentPos.z + ( u.z * Math.cos( angle ) + v.z * Math.sin( angle ) ) * radius
        );
        geometry.vertices.push( new THREE.Vertex( point ) );
    }

    var material = new THREE.LineBasicMaterial( { color: color, opacity: 0.5 } );
    scene.add( new THREE.Line( geometry, material ) );
}

function onDocumentMouseUp( event ) {

    event.preventDefault();

    isMouseDown = false;
    onMouseDownPosition.x = event.clientX - onMouseDownPosition.x;
    onMouseDownPosition.y = event.clientY - onMouseDownPosition.y;

    if ( event.which == 3 ) {
        rotate = true;
    }

    if ( onMouseDownPosition.length() > 5 ) {
        return;
    }

    update();
}

function onDocumentMouseDown( event ) {

    if ( event.target.closest && event.target.closest( '#searchBox' ) ) {
        return;
    }

    event.preventDefault();

    isMouseDown = true;
    rotate = false;

    onMouseDownTheta = theta;
    onMouseDownPhi = phi;
    onMouseDownPosition.x = event.clientX;
    onMouseDownPosition.y = event.clientY;

    var vector = new THREE.Vector3( mouse.x, mouse.y, 1 );
    projector.unprojectVector( vector, camera );
    var ray = new THREE.Ray( camera.position, vector.subSelf( camera.position ).normalize() );

    var intersects = ray.intersectObjects( scene.children );

    if ( intersects.length > 0 ) {
        var hit = intersects[ 0 ].object;

        if ( hit.destSystemId ) {
            window.location = "system.php?system=" + hit.destSystemId;
        } else if ( hit.itemType === 'Planet' && !currentPlanetId ) {
            window.location = "system.php?system=" + currentSystemId + "&planet=" + hit.itemId;
        }
    }
}

function onDocumentMouseMove( event ) {

    event.preventDefault();
    mouse.x = ( event.clientX / window.innerWidth ) * 2 - 1;
    mouse.y = - ( event.clientY / window.innerHeight ) * 2 + 1;

    if ( isMouseDown ) {

        theta = - ( ( event.clientX - onMouseDownPosition.x ) * 0.5 ) + onMouseDownTheta;
        phi = ( ( event.clientY - onMouseDownPosition.y ) * 0.5 ) + onMouseDownPhi;

        phi = Math.min( 180, Math.max( 0, phi ) );

        positionCameraFromOrbit();
        update();
    }
}

// places the camera at the current theta/phi/radius around target - used
// both while dragging and when the wheel changes radius after a drag has
// parked the camera (auto-rotate repositions itself every frame on its
// own, but a parked camera only moves when something calls this)
function positionCameraFromOrbit() {
    camera.position.x = target.x + radius * Math.sin( theta * Math.PI / 360 ) * Math.cos( phi * Math.PI / 360 );
    camera.position.y = target.y + radius * Math.sin( phi * Math.PI / 360 );
    camera.position.z = target.z + radius * Math.cos( theta * Math.PI / 360 ) * Math.cos( phi * Math.PI / 360 );
    camera.updateMatrix();
}

function onDocumentMouseWheel( event ) {

    if ( event.detail ) {
        radius -= event.detail * 10;
    }
    if ( event.wheelDelta ) {
        radius -= event.wheelDelta;
    }
    if ( !rotate ) {
        positionCameraFromOrbit();
    }
    update();
}
