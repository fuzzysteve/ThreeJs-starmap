// Shared Three.js star renderer for constellation.php and region.php.
//
// The including page must define, before loading this file:
//   stars         - array of {x,y,z,name,luminosity,constellationid,regionid,systemid}
//   jumps         - array of {fx,fy,fz,tx,ty,tz}
//   currentGroupId - id of the constellation/region currently on screen
//   groupField    - "constellationid" or "regionid": which star field currentGroupId is compared against
//   zoomSystemId  - systemid to center the camera on, or null
//   linkBuilder(star) - returns the URL to navigate to when a star is clicked

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

// project each star's 3D position into screen space so its name label
// can be kept positioned over it every frame
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

    var geometry = new THREE.SphereGeometry( 10, 16, 16 );
    var offset = 210;
    var zoomTarget = null;

    for ( var i = 0; i < stars.length; i++ ) {
        var star = stars[ i ];
        var isCurrent = ( star[ groupField ] === currentGroupId );
        var color = isCurrent ? ( star.luminosity * 0xffffff ) : 0x333333;

        var particle = new THREE.Mesh( geometry, new THREE.MeshLambertMaterial( { color: color } ) );
        particle.position.x = star.x - offset;
        particle.position.y = star.y - offset;
        particle.position.z = star.z - offset;
        particle.name = star.name;
        particle.constellationid = star.constellationid;
        particle.regionid = star.regionid;
        particle.systemid = star.systemid;
        scene.add( particle );
        particles.push( particle );

        var label = document.createElement( 'div' );
        label.className = 'starLabel';
        label.style.color = isCurrent ? '#ffffff' : '#666666';
        label.textContent = star.name;
        document.body.appendChild( label );
        particle.label = label;

        if ( zoomSystemId && star.systemid == zoomSystemId ) {
            zoomTarget = particle.position;
        }
    }

    if ( zoomTarget ) {
        target.copy( zoomTarget );
        radius = 120;
    }

    var material = new THREE.LineBasicMaterial( { color: 0xcccccc, opacity: 0.4, linewidth: 1 } );

    for ( var j = 0; j < jumps.length; j++ ) {
        var jump = jumps[ j ];
        var geo = new THREE.Geometry();
        geo.vertices.push( new THREE.Vertex( new THREE.Vector3( jump.fx - offset, jump.fy - offset, jump.fz - offset ) ) );
        geo.vertices.push( new THREE.Vertex( new THREE.Vector3( jump.tx - offset, jump.ty - offset, jump.tz - offset ) ) );
        scene.add( new THREE.Line( geo, material ) );
    }
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

    if ( intersects.length > 0 && intersects[ 0 ].object.systemid ) {
        window.location = linkBuilder( intersects[ 0 ].object );
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
