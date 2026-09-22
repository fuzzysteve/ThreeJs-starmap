<?php
// JSON data source for gpusystem.php (the WebGPU solar system viewer).
//
//   gpusystem-data.php?system=<solarSystemID>
//       everything in one solar system, in real metres (not rescaled -
//       the renderer copes with the full range itself), plus whatever
//       mapCelestialStatistics knows about each body
//   gpusystem-data.php?sky=1
//       every k-space system's galactic position, used to paint the real
//       neighbouring stars into the background sky

require_once('db.inc.php');

header('Content-Type: application/json');

$dbh->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

// light-years are plenty precise for background stars and keep the
// payload about a third of the size of raw metres
define('METRES_PER_LY', 9460730472580800);

if (array_key_exists('sky', $_GET))
{
header('Cache-Control: public, max-age=86400');

$sql="select x, y, z, security from mapSolarSystems where regionID < 11000000";
$stmt = $dbh->prepare($sql);
$stmt->execute();

$flat=array();
while ($row = $stmt->fetch())
{
$flat[]=round($row['x']/METRES_PER_LY, 3);
$flat[]=round($row['y']/METRES_PER_LY, 3);
$flat[]=round($row['z']/METRES_PER_LY, 3);
$flat[]=round((float)$row['security'], 2);
}

echo json_encode(array('metresPerLy'=>METRES_PER_LY, 'stars'=>$flat));
exit;
}

$system=30000142;
if (array_key_exists('system',$_GET) && is_numeric($_GET['system']))
{
$system=(int)$_GET['system'];
}

$sql="select ms.solarSystemID, ms.solarSystemName, ms.security, ms.x, ms.y, ms.z,
       ms.constellationID, mc.constellationName, ms.regionID, mr.regionName
from mapSolarSystems ms
left join mapConstellations mc on mc.constellationID = ms.constellationID
left join mapRegions mr on mr.regionID = ms.regionID
where ms.solarSystemID = ?";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($system));
$row = $stmt->fetch();

if (!$row)
{
http_response_code(404);
echo json_encode(array('error'=>'Unknown solar system'));
exit;
}

$systemInfo=array(
    'id'=>(int)$row['solarSystemID'],
    'name'=>$row['solarSystemName'],
    'security'=>(float)$row['security'],
    'x'=>(float)$row['x'],
    'y'=>(float)$row['y'],
    'z'=>(float)$row['z'],
    'constellationId'=>(int)$row['constellationID'],
    'constellationName'=>$row['constellationName'],
    'regionId'=>(int)$row['regionID'],
    'regionName'=>$row['regionName']
);

// groups 3/4/5 are the region/constellation/system entries themselves.
// mapCelestialStatistics covers suns, planets, moons and belts only -
// stations and stargates get nulls there (and have no radius at all in
// the SDE, so the viewer gives them a nominal display size)
$sql="select md.itemID, md.itemName, md.groupID, ig.groupName, it.typeName,
       md.x, md.y, md.z, md.radius, md.orbitID, md.celestialIndex, md.orbitIndex,
       cs.temperature, cs.spectralClass, cs.luminosity, cs.age,
       cs.orbitRadius, cs.eccentricity, cs.orbitPeriod, cs.rotationRate, cs.locked,
       cs.pressure, cs.density, cs.surfaceGravity, cs.escapeVelocity,
       cs.massDust, cs.massGas, cs.fragmented
from mapDenormalize md
join invGroups ig on ig.groupID = md.groupID
left join invTypes it on it.typeID = md.typeID
left join mapCelestialStatistics cs on cs.celestialID = md.itemID
where md.solarSystemID = ?
and md.groupID not in (3,4,5)
order by md.celestialIndex, md.orbitIndex, md.itemID";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($system));

$statColumns=array('temperature','spectralClass','luminosity','age','orbitRadius','eccentricity',
    'orbitPeriod','rotationRate','locked','pressure','density','surfaceGravity','escapeVelocity',
    'massDust','massGas','fragmented');

$items=array();
while ($row = $stmt->fetch())
{
$stats=null;
foreach ($statColumns as $col)
{
if ($row[$col] !== null)
{
if ($stats === null)
{
$stats=array();
}
$stats[$col]=($col === 'spectralClass') ? $row[$col] : (float)$row[$col];
}
}

$items[(int)$row['itemID']]=array(
    'id'=>(int)$row['itemID'],
    'name'=>$row['itemName'],
    'groupId'=>(int)$row['groupID'],
    'group'=>$row['groupName'],
    'typeName'=>$row['typeName'],
    'x'=>(float)$row['x'],
    'y'=>(float)$row['y'],
    'z'=>(float)$row['z'],
    'radius'=>$row['radius'] === null ? null : (float)$row['radius'],
    'orbitId'=>$row['orbitID'] === null ? null : (int)$row['orbitID'],
    'celestialIndex'=>$row['celestialIndex'] === null ? null : (int)$row['celestialIndex'],
    'orbitIndex'=>$row['orbitIndex'] === null ? null : (int)$row['orbitIndex'],
    'stats'=>$stats,
    'dest'=>null
);
}

$sql="select mj.stargateID, mj.destinationID, ms.solarSystemID, ms.solarSystemName, ms.security, ms.x, ms.y, ms.z
from mapJumps mj
join mapDenormalize src on src.itemID = mj.stargateID
join mapDenormalize dst on dst.itemID = mj.destinationID
join mapSolarSystems ms on ms.solarSystemID = dst.solarSystemID
where src.solarSystemID = ?";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($system));

while ($row = $stmt->fetch())
{
$gateId=(int)$row['stargateID'];
if (array_key_exists($gateId, $items))
{
$items[$gateId]['dest']=array(
    'gateId'=>(int)$row['destinationID'],
    'systemId'=>(int)$row['solarSystemID'],
    'systemName'=>$row['solarSystemName'],
    'security'=>(float)$row['security'],
    'x'=>(float)$row['x'],
    'y'=>(float)$row['y'],
    'z'=>(float)$row['z']
);
}
}

echo json_encode(array('system'=>$systemInfo, 'items'=>array_values($items)));
