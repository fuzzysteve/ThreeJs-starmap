<?php

require_once('db.inc.php');

header('Content-Type: application/json');

$q = (array_key_exists('q', $_GET) && is_string($_GET['q'])) ? trim($_GET['q']) : '';

$results = array();

if (strlen($q) >= 2) {

$like = '%'.$q.'%';

$sql="select solarSystemID as id, solarSystemName as name, constellationID as constellationid, regionID as regionid from mapSolarSystems where solarSystemName like ? order by solarSystemName limit 10";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($like));
while ($row = $stmt->fetchObject())
{
$results[] = array('type'=>'system', 'id'=>(int)$row->id, 'name'=>$row->name, 'constellationid'=>(int)$row->constellationid, 'regionid'=>(int)$row->regionid);
}

$sql="select constellationID as id, constellationName as name, regionID as regionid from mapConstellations where constellationName like ? order by constellationName limit 10";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($like));
while ($row = $stmt->fetchObject())
{
$results[] = array('type'=>'constellation', 'id'=>(int)$row->id, 'name'=>$row->name, 'regionid'=>(int)$row->regionid);
}

$sql="select regionID as id, regionName as name from mapRegions where regionName like ? order by regionName limit 10";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($like));
while ($row = $stmt->fetchObject())
{
$results[] = array('type'=>'region', 'id'=>(int)$row->id, 'name'=>$row->name);
}

}

echo json_encode($results);
