<?php

require_once('db.inc.php');

$region=10000002;
if (array_key_exists('region',$_GET) && is_numeric($_GET['region']))
{
$region=$_GET['region'];
}

$zoomSystem=null;
if (array_key_exists('system',$_GET) && is_numeric($_GET['system']))
{
$zoomSystem=(int)$_GET['system'];
}

$sql="select regionname from mapRegions where regionid=?";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($region));

$regionName="";
if ($row = $stmt->fetchObject())
{
$regionName=$row->regionname;
}

$sql="select max(x)-min(x) scaler,min(x) minx,min(y) miny,min(z) minz from mapSolarSystems where regionid=?";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($region));

$scaler=0;
$minx=0;
$miny=0;
$minz=0;
if ($row = $stmt->fetchObject())
{
$scaler=$row->scaler;
$minx=$row->minx;
$miny=$row->miny;
$minz=$row->minz;
}

$sql="select distinct constellationid,regionid,solarsystemid,solarsystemname,floor((x-:minx)/:scalar *420) x ,floor((y-:miny)/:scalar *420) y,floor((z-:minz)/:scalar *420) z,if(regionid=:region,luminosity,0.1) luminosity  from mapSolarSystems,mapSolarSystemJumps where fromRegionID=:region and (mapSolarSystemJumps.toSolarSystemID=solarsystemid or mapSolarSystemJumps.fromSolarSystemID=solarsystemid)";

$stmt = $dbh->prepare($sql);
$stmt->execute(array(":minx"=>$minx,":miny"=>$miny,":minz"=>$minz,":scalar"=>$scaler,":region"=>$region));

$starRows=array();
while ($row = $stmt->fetchObject())
{
$starRows[]=array('x'=>(float)$row->x,'y'=>(float)$row->y,'z'=>(float)$row->z,'name'=>$row->solarsystemname,'luminosity'=>(float)$row->luminosity,'constellationid'=>(int)$row->constellationid,'regionid'=>(int)$row->regionid,'systemid'=>(int)$row->solarsystemid);
}

$sql="select floor((mss1.x- :minx)/:scalar *420) fx ,floor((mss1.y- :miny)/:scalar *420) fy,floor((mss1.z- :minz)/:scalar *420) fz,floor((mss2.x- :minx)/:scalar *420) tx ,floor((mss2.y- :miny)/:scalar *420) ty,floor((mss2.z- :minz)/:scalar *420) tz  from mapSolarSystems mss1,mapSolarSystems mss2,mapSolarSystemJumps where mss1.solarsystemid=fromSolarSystemID and mss2.solarsystemid=toSolarSystemID and fromRegionID=:region";

$stmt = $dbh->prepare($sql);
$stmt->execute(array(":minx"=>$minx,":miny"=>$miny,":minz"=>$minz,":scalar"=>$scaler,":region"=>$region));

$jumpRows=array();
while ($row = $stmt->fetchObject())
{
$jumpRows[]=array('fx'=>(float)$row->fx,'fy'=>(float)$row->fy,'fz'=>(float)$row->fz,'tx'=>(float)$row->tx,'ty'=>(float)$row->ty,'tz'=>(float)$row->tz);
}

?>
<!DOCTYPE HTML>
<html lang="en">
    <head>
        <title>Region display</title>
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
            #regionName {
                position: absolute;
                top: 40px;
                left: 0px;
                width: 100%;
                text-align: center;
                color: white;
                font-family: helvetica, arial, sans-serif;
                font-size: 24px;
                pointer-events: none;
                z-index: 5;
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
        </style>

    </head>
    <body>
<div style="position:absolute;display:block;color:white">Click, hold and drag to rotate. right click to restart rotation. mousewheel to zoom during rotation. Click a system to view its constellation, or a dimmed neighbouring system to jump to that region.</div>
<div id="searchBox">
<input type="text" id="starSearch" placeholder="Search systems, constellations, regions&hellip;" autocomplete="off">
<div id="searchResults"></div>
</div>
<div id="regionName"><?php echo htmlspecialchars($regionName, ENT_QUOTES, 'UTF-8'); ?></div>

        <script>
stars=<?php echo json_encode($starRows); ?>;
jumps=<?php echo json_encode($jumpRows); ?>;
currentGroupId=<?php echo (int)$region; ?>;
groupField="regionid";
zoomSystemId=<?php echo $zoomSystem===null ? 'null' : (int)$zoomSystem; ?>;

function linkBuilder(star) {
    if (star.regionid == currentGroupId) {
        return "constellation.php?constellation=" + star.constellationid + "&system=" + star.systemid;
    }
    return "region.php?region=" + star.regionid;
}
        </script>
        <script type="module" src="viewer.js"></script>
        <script src="search.js"></script>
    </body>
</html>
