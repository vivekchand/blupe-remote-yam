"""Pure packet receipt validation; assertions confer no source authority."""
import time

import pytest

from remote_yam.trajectory_provenance import make_receipt, validate_receipt, packet_digest, measured_baseline


@pytest.fixture
def provenance():
    now=time.time()
    source=dict(plan_id='plan',attempt_id='attempt',session_id='session',episode_id='episode',lease_id='private-lease',
        robot_id='yam-1',api_origin='https://example.invalid/v1',api_identity=123,
        first_step_id=42,cadence_hz=10)
    observation=dict(jetson_id='yam-1',source='hardware',observed_at=now,settled=True,
        homed=True,mode='API_ACTIVE',safety=dict(ok=True,estop_engaged=False,contact_count=0),
        left_joints_deg=[0.]*6,right_joints_deg=[0.]*6,left_gripper=1.,right_gripper=.9)
    points=[dict(step_id=42,left_joints_deg=[.1]*6,right_joints_deg=[0.]*6,
                 left_gripper=1.,right_gripper=.8)]
    return source,observation,points,now


def test_receipt_keeps_raw_degrees_and_exact_packet_detached(provenance):
    source,observation,points,now=provenance
    observation['left_joints_deg'][0]=.400000000000003
    receipt=make_receipt(points,observation,source,7)
    assert validate_receipt(receipt,points,source,now=now,planning_observed_at=now-1)==observation
    source['lease_id']='changed';points[0]['left_joints_deg'][0]=99;observation['left_joints_deg'][0]=99
    assert receipt['source']['lease_id']=='private-lease' and receipt['observation']['left_joints_deg'][0]==.400000000000003


@pytest.mark.parametrize('field,value', [
    ('observed_at',True),('observed_at',float('nan')),('observed_at',10**1000),
    ('observed_at',float('inf')),('source','simulation'),('robot_id','foreign'),
    ('jetson_id','foreign'),('settled',False),('mode','EXECUTING'),('mode','HOMING'),
    ('mode','DISABLED'),('mode','FAULT'),('left_joints_deg',[0.]*5),
    ('left_joints_deg',[True]*6),('left_joints_deg',[10**1000]*6),
    ('left_gripper',True),('right_gripper',1.001),('right_gripper',None),
    ('safety',dict(ok=True,estop_engaged=False,active_contacts=[1])),
    ('safety',dict(ok=True,estop_engaged=False,contact_count=1)),
    ('safety',dict(ok=False,estop_engaged=False)),('safety',dict(ok=True,estop_engaged=True)),
])
def test_unqualified_baseline_never_validates(provenance,field,value):
    source,observation,points,now=provenance;observation[field]=value
    with pytest.raises(ValueError):
        receipt=make_receipt(points,observation,source,0)
        validate_receipt(receipt,points,source,now=now,planning_observed_at=now-1)


@pytest.mark.parametrize('offset,planning_offset',[(3.,-1.),(-6.,-7.),(-1.,0.)])
def test_future_expired_or_regressed_raw_clock_rejected(provenance,offset,planning_offset):
    source,observation,points,now=provenance;observation['observed_at']=now+offset
    receipt=make_receipt(points,observation,source,0)
    with pytest.raises(ValueError):validate_receipt(receipt,points,source,now=now,planning_observed_at=now+planning_offset)


@pytest.mark.parametrize('field,value',[('api_identity',True),('first_step_id',True),('cadence_hz',True),
    ('lease_id',''),('attempt_id',None),('cadence_hz',11),('api_identity',0)])
def test_invalid_source_contract_rejected(provenance,field,value):
    source,observation,points,_=provenance;source[field]=value
    with pytest.raises(ValueError):make_receipt(points,observation,source,0)


@pytest.mark.parametrize('mutation',['target','step','width','extra','nan','empty'])
def test_packet_changes_cannot_match_original_receipt(provenance,mutation):
    source,observation,points,now=provenance;receipt=make_receipt(points,observation,source,0)
    if mutation=='target':points[0]['left_joints_deg'][0]=.2
    elif mutation=='step':points[0]['step_id']+=1
    elif mutation=='width':points[0]['right_joints_deg']=[0.]*5
    elif mutation=='extra':points[0]['unrecognized']='not a packet'
    elif mutation=='nan':points[0]['right_gripper']=float('nan')
    else:points.clear()
    with pytest.raises(ValueError):validate_receipt(receipt,points,source,now=now,planning_observed_at=now-1)
