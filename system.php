<?php

require_once('db.inc.php');

$system=30000142;
if (array_key_exists('system',$_GET) && is_numeric($_GET['system']))
{
$system=$_GET['system'];
}

$sql="select solarsystemname, constellationid, regionid, security from mapSolarSystems where solarsystemid=?";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($system));

$systemName="";
$constellationId=null;
$regionId=null;
$security=null;
if ($row = $stmt->fetchObject())
{
$systemName=$row->solarsystemname;
$constellationId=(int)$row->constellationid;
$regionId=(int)$row->regionid;
$security=(float)$row->security;
}

// drilling into a single planet's moons needs its own tight bounding box:
// a moon can sit only ~1e8m from its planet while the system as a whole
// spans ~1e13m, so sharing one scale would collapse every moon onto its
// planet's sphere
$planet=null;
$planetName="";
if (array_key_exists('planet',$_GET) && is_numeric($_GET['planet']))
{
$sql="select itemname from mapDenormalize where itemid=? and solarsystemid=? and groupid=7";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($_GET['planet'], $system));
if ($row = $stmt->fetchObject())
{
$planet=(int)$_GET['planet'];
$planetName=$row->itemname;
}
}

// a station's orbitid points at a moon or (occasionally) straight at a
// planet, so "everything in this planet's view" is: the planet itself,
// anything orbiting it directly (moons, or a station with no moon), and
// anything orbiting one of its moons (the rest of the stations)
$planetScopeCondition="(itemid=:planet or orbitid=:planet or orbitid in (select itemid from mapDenormalize where solarsystemid=:system and orbitid=:planet and groupid=8))";

if ($planet !== null)
{
$sql="select greatest(max(x)-min(x),max(y)-min(y),max(z)-min(z)) scaler,min(x) minx,min(y) miny,min(z) minz from mapDenormalize where solarsystemid=:system and groupid in (7,8,15) and $planetScopeCondition";
$scopeParams=array(':system'=>$system,':planet'=>$planet);
}
else
{
// scale using whichever axis has the widest spread, so long-range
// stargates on one axis don't get clipped just because another axis
// is narrower. moons and stations are excluded here too - they're
// only shown in the planet drill-down view, listed in the sidebar
// on this view instead
$sql="select greatest(max(x)-min(x),max(y)-min(y),max(z)-min(z)) scaler,min(x) minx,min(y) miny,min(z) minz from mapDenormalize where solarsystemid=:system and groupid not in (3,4,5,8,15)";
$scopeParams=array(':system'=>$system);
}
$stmt = $dbh->prepare($sql);
$stmt->execute($scopeParams);

$scaler=1;
$minx=0;
$miny=0;
$minz=0;
$row = $stmt->fetchObject();
if ($row && $row->scaler > 0)
{
$scaler=$row->scaler;
$minx=$row->minx;
$miny=$row->miny;
$minz=$row->minz;
}

if ($planet !== null)
{
$sql="select md.itemid,md.itemname,md.orbitid,ig.groupname as type,floor((md.x-:minx)/:scalar *420) x,floor((md.y-:miny)/:scalar *420) y,floor((md.z-:minz)/:scalar *420) z from mapDenormalize md join invGroups ig on ig.groupid=md.groupid where md.solarsystemid=:system and md.groupid in (7,8,15) and $planetScopeCondition";
$scopeParams=array(':minx'=>$minx,':miny'=>$miny,':minz'=>$minz,':scalar'=>$scaler,':system'=>$system,':planet'=>$planet);
}
else
{
$sql="select md.itemid,md.itemname,md.orbitid,ig.groupname as type,floor((md.x-:minx)/:scalar *420) x,floor((md.y-:miny)/:scalar *420) y,floor((md.z-:minz)/:scalar *420) z from mapDenormalize md join invGroups ig on ig.groupid=md.groupid where md.solarsystemid=:system and md.groupid not in (3,4,5,8,15)";
$scopeParams=array(':minx'=>$minx,':miny'=>$miny,':minz'=>$minz,':scalar'=>$scaler,':system'=>$system);
}
$stmt = $dbh->prepare($sql);
$stmt->execute($scopeParams);

$itemRows=array();
while ($row = $stmt->fetchObject())
{
$itemRows[(int)$row->itemid]=array('id'=>(int)$row->itemid,'x'=>(float)$row->x,'y'=>(float)$row->y,'z'=>(float)$row->z,'name'=>$row->itemname,'type'=>$row->type,'orbitid'=>$row->orbitid===null ? null : (int)$row->orbitid,'destSystemId'=>null);
}

if ($planet === null)
{
$sql="select md1.itemid as stargateid, md2.solarsystemid as destsystemid from mapJumps mj join mapDenormalize md1 on md1.itemid=mj.stargateid join mapDenormalize md2 on md2.itemid=mj.destinationid where md1.solarsystemid=:system";
$stmt = $dbh->prepare($sql);
$stmt->execute(array(':system'=>$system));

while ($row = $stmt->fetchObject())
{
if (array_key_exists((int)$row->stargateid, $itemRows))
{
$itemRows[(int)$row->stargateid]['destSystemId']=(int)$row->destsystemid;
}
}
}

$itemRows=array_values($itemRows);

// moons and stations aren't drawn on the whole-system view (see above) -
// list them in a sidebar instead, grouped under the planet whose
// drill-down view actually shows them. a station's parent is resolved
// either directly (orbits the planet) or via its moon (orbits the moon)
$sidebarByPlanet=array();
if ($planet === null)
{
$sql="select md.itemid, md.itemname, md.groupid,
       coalesce(direct_planet.itemid, moon_planet.itemid) as planetid,
       coalesce(direct_planet.itemname, moon_planet.itemname) as planetname,
       coalesce(direct_planet.celestialindex, moon_planet.celestialindex) as planetindex,
       coalesce(moon.orbitindex, md.orbitindex) as sortindex
from mapDenormalize md
left join mapDenormalize direct_planet on direct_planet.itemid = md.orbitid and direct_planet.groupid = 7
left join mapDenormalize moon on moon.itemid = md.orbitid and moon.groupid = 8
left join mapDenormalize moon_planet on moon_planet.itemid = moon.orbitid and moon_planet.groupid = 7
where md.solarsystemid = :system
and md.groupid in (8,15)
order by planetindex, sortindex, md.groupid, md.itemname";
$stmt = $dbh->prepare($sql);
$stmt->execute(array(':system'=>$system));

while ($row = $stmt->fetchObject())
{
if ($row->planetid === null)
{
continue;
}
$pid=(int)$row->planetid;
if (!array_key_exists($pid, $sidebarByPlanet))
{
$sidebarByPlanet[$pid]=array('name'=>$row->planetname,'items'=>array());
}
$sidebarByPlanet[$pid]['items'][]=array('id'=>(int)$row->itemid,'name'=>$row->itemname,'type'=>((int)$row->groupid===8?'Moon':'Station'));
}
}

?>
<!DOCTYPE HTML>
<html lang="en">
    <head>
        <title>System display</title>
        <meta charset="utf-8">

        <style type="text/css">
            body {
                background-color: #000000;
                margin: 0px;
                overflow: hidden;
            }
            .starLabel {
                position: absolute;
                pointer-events: none;
                font-family: helvetica, arial, sans-serif;
                font-size: 11px;
                white-space: nowrap;
                z-index: 5;
            }
            #systemName {
                position: absolute;
                top: 40px;
                left: 0px;
                width: 100%;
                text-align: center;
                color: white;
                font-family: helvetica, arial, sans-serif;
                font-size: 24px;
                z-index: 5;
            }
            #systemName .security {
                font-size: 16px;
            }
            #systemName a {
                color: #6cf;
                font-size: 14px;
            }
            #searchBox {
                position: absolute;
                top: 10px;
                left: 10px;
                z-index: 20;
                font-family: helvetica, arial, sans-serif;
            }
            #starSearch {
                width: 240px;
                padding: 4px 6px;
                font-size: 13px;
            }
            #searchResults {
                display: none;
                width: 252px;
                max-height: 300px;
                overflow-y: auto;
                background: #111111;
                border: 1px solid #444444;
            }
            .searchResultRow {
                padding: 4px 6px;
                color: white;
                font-size: 13px;
                cursor: pointer;
            }
            .searchResultRow:hover {
                background: #333333;
            }
            .searchResultType {
                display: inline-block;
                width: 80px;
                color: #888888;
                font-size: 11px;
                text-transform: uppercase;
            }
            #sidebarList {
                position: absolute;
                top: 0px;
                right: 0px;
                width: 260px;
                height: 100%;
                overflow-y: auto;
                background: rgba(0,0,0,0.75);
                font-family: helvetica, arial, sans-serif;
                font-size: 12px;
                z-index: 15;
                box-sizing: border-box;
                padding: 10px;
            }
            #sidebarList a {
                display: block;
                padding: 2px 0px 2px 10px;
                text-decoration: none;
            }
            #sidebarList a.planetLink {
                padding-left: 0px;
                margin-top: 10px;
                font-weight: bold;
                color: #66ccff;
            }
            #sidebarList a.moonLink {
                color: #999999;
            }
            #sidebarList a.stationLink {
                color: #33ffcc;
            }
            #sidebarList a:hover {
                text-decoration: underline;
            }
        </style>

    </head>
    <body>
<div style="position:absolute;display:block;color:white"><?php if ($planet !== null) { ?>Click, hold and drag to rotate. right click to restart rotation. mousewheel to zoom.<?php } else { ?>Click, hold and drag to rotate. right click to restart rotation. mousewheel to zoom. Click a stargate to jump to the system it leads to, or a planet to see its moons and stations up close.<?php } ?></div>
<div id="searchBox">
<input type="text" id="starSearch" placeholder="Search systems, constellations, regions&hellip;" autocomplete="off">
<div id="searchResults"></div>
</div>
<?php if ($planet === null && count($sidebarByPlanet) > 0) { ?>
<div id="sidebarList">
<?php foreach ($sidebarByPlanet as $pid => $group) { ?>
<a class="planetLink" href="system.php?system=<?php echo (int)$system; ?>&planet=<?php echo $pid; ?>"><?php echo htmlspecialchars($group['name'], ENT_QUOTES, 'UTF-8'); ?></a>
<?php foreach ($group['items'] as $sidebarItem) { ?>
<a class="<?php echo $sidebarItem['type']==='Moon' ? 'moonLink' : 'stationLink'; ?>" href="system.php?system=<?php echo (int)$system; ?>&planet=<?php echo $pid; ?>"><?php echo htmlspecialchars($sidebarItem['name'], ENT_QUOTES, 'UTF-8'); ?></a>
<?php } ?>
<?php } ?>
</div>
<?php } ?>
<div id="systemName">
<?php if ($planet !== null) { ?>
<?php echo htmlspecialchars($planetName, ENT_QUOTES, 'UTF-8'); ?>
 <a href="system.php?system=<?php echo (int)$system; ?>">back to <?php echo htmlspecialchars($systemName, ENT_QUOTES, 'UTF-8'); ?></a>
<?php } else { ?>
<?php echo htmlspecialchars($systemName, ENT_QUOTES, 'UTF-8'); ?>
<span class="security"><?php echo htmlspecialchars(number_format($security, 1), ENT_QUOTES, 'UTF-8'); ?></span>
<?php if ($constellationId) { ?> <a href="constellation.php?constellation=<?php echo $constellationId; ?>&system=<?php echo (int)$system; ?>">view constellation</a><?php } ?>
<?php if ($regionId) { ?> <a href="region.php?region=<?php echo $regionId; ?>">view region</a><?php } ?>
<?php } ?>
</div>
        <script src="Three.js"></script>

        <script>
items=<?php echo json_encode($itemRows); ?>;
currentSystemId=<?php echo (int)$system; ?>;
currentPlanetId=<?php echo $planet === null ? 'null' : $planet; ?>;
        </script>
        <script src="systemViewer.js"></script>
        <script src="search.js"></script>
    </body>
</html>
