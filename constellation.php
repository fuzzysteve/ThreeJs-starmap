<?php

require_once('db.inc.php');

$constellation=20000020;
if (array_key_exists('constellation',$_GET) && is_numeric($_GET['constellation']))
{
$constellation=$_GET['constellation'];
}

$zoomSystem=null;
if (array_key_exists('system',$_GET) && is_numeric($_GET['system']))
{
$zoomSystem=(int)$_GET['system'];
}

$sql="select constellationname, regionid from mapConstellations where constellationid=?";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($constellation));

$constellationName="";
$regionId=null;
if ($row = $stmt->fetchObject())
{
$constellationName=$row->constellationname;
$regionId=(int)$row->regionid;
}

$sql="select max(x)-min(x) scaler,min(x) minx,min(y) miny,min(z) minz from mapSolarSystems where constellationid=?";
$stmt = $dbh->prepare($sql);
$stmt->execute(array($constellation));

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

$sql="select distinct constellationid,regionid,solarsystemid,solarsystemname,floor((x-:minx)/:scalar *420) x ,floor((y-:miny)/:scalar *420) y,floor((z-:minz)/:scalar *420) z,if(constellationid=:constellation,luminosity,0.1) luminosity  from mapSolarSystems,mapSolarSystemJumps where fromconstellationid=:constellation and (mapSolarSystemJumps.toSolarSystemID=solarsystemid or mapSolarSystemJumps.fromSolarSystemID=solarsystemid)";

$stmt = $dbh->prepare($sql);
$stmt->execute(array(":minx"=>$minx,":miny"=>$miny,":minz"=>$minz,":scalar"=>$scaler,":constellation"=>$constellation));

$starRows=array();
while ($row = $stmt->fetchObject())
{
$starRows[]=array('x'=>(float)$row->x,'y'=>(float)$row->y,'z'=>(float)$row->z,'name'=>$row->solarsystemname,'luminosity'=>(float)$row->luminosity,'constellationid'=>(int)$row->constellationid,'regionid'=>(int)$row->regionid,'systemid'=>(int)$row->solarsystemid);
}

$sql="select floor((mss1.x- :minx)/:scalar *420) fx ,floor((mss1.y- :miny)/:scalar *420) fy,floor((mss1.z- :minz)/:scalar *420) fz,floor((mss2.x- :minx)/:scalar *420) tx ,floor((mss2.y- :miny)/:scalar *420) ty,floor((mss2.z- :minz)/:scalar *420) tz  from mapSolarSystems mss1,mapSolarSystems mss2,mapSolarSystemJumps where mss1.solarsystemid=fromSolarSystemID and mss2.solarsystemid=toSolarSystemID and fromconstellationid=:constellation";

$stmt = $dbh->prepare($sql);
$stmt->execute(array(":minx"=>$minx,":miny"=>$miny,":minz"=>$minz,":scalar"=>$scaler,":constellation"=>$constellation));

$jumpRows=array();
while ($row = $stmt->fetchObject())
{
$jumpRows[]=array('fx'=>(float)$row->fx,'fy'=>(float)$row->fy,'fz'=>(float)$row->fz,'tx'=>(float)$row->tx,'ty'=>(float)$row->ty,'tz'=>(float)$row->tz);
}

?>
<!DOCTYPE HTML>
<html lang="en">
    <head>
        <title>Constellation display</title>
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
            #constellationName {
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
            #constellationName a {
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
        </style>

    </head>
    <body>
<div style="position:absolute;display:block;color:white">Click, hold and drag to rotate. right click to restart rotation. mousewheel to zoom during rotation (as I'm still more than a little shaky on the camera positioning math)</div>
<div id="searchBox">
<input type="text" id="starSearch" placeholder="Search systems, constellations, regions&hellip;" autocomplete="off">
<div id="searchResults"></div>
</div>
<div id="constellationName"><?php echo htmlspecialchars($constellationName, ENT_QUOTES, 'UTF-8'); ?><?php if ($regionId) { ?> <a href="region.php?region=<?php echo $regionId; ?>">view region</a><?php } ?><?php if ($zoomSystem !== null) { ?> <a href="system.php?system=<?php echo $zoomSystem; ?>">view system contents</a><?php } ?></div>

        <script>
stars=<?php echo json_encode($starRows); ?>;
jumps=<?php echo json_encode($jumpRows); ?>;
currentGroupId=<?php echo (int)$constellation; ?>;
groupField="constellationid";
zoomSystemId=<?php echo $zoomSystem===null ? 'null' : (int)$zoomSystem; ?>;

function linkBuilder(star) {
    return "constellation.php?constellation=" + star.constellationid + "&system=" + star.systemid;
}
        </script>
        <script type="module" src="viewer.js"></script>
        <script src="search.js"></script>
    </body>
</html>
