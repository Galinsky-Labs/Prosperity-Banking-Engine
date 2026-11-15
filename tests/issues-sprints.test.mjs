import test from 'node:test';
import assert from 'node:assert/strict';
import {spotIssues} from '../src/studio/issue-spotting.mjs';
import {SprintBoard} from '../src/studio/sprints.mjs';

const none={handlesPersonalData:false,handlesFundsOrPayments:false,offersCreditOrLending:false,offersSecuritiesOrInvestments:false,handlesHealthData:false,targetsChildren:false,operatesCrossBorder:false,automatedDecisionsAboutPeople:false,collectsBiometrics:false,usesThirdPartyBrandNames:false,sendsMarketingMessages:false};

test('issue spotting raises counsel questions, never compliance conclusions',()=>{
 const clean=spotIssues({projectId:'p-1',profile:none,dependencies:[{name:'left-pad',license:'MIT'}]});
 assert.equal(clean.issues.length,0);assert.equal(clean.requiresCounselReview,false);assert.equal(clean.notLegalAdvice,true);assert.match(clean.statement,/does not determine legality/);
 const fintech=spotIssues({projectId:'p-1',profile:{...none,handlesPersonalData:true,handlesFundsOrPayments:true,usesThirdPartyBrandNames:true},dependencies:[{name:'db-driver',license:'AGPL-3.0'},{name:'lib-x',license:'GPL-3.0'},{name:'mystery',license:'Custom-EULA'}]});
 assert.deepEqual(fintech.issues.map(issue=>issue.area),['privacy','money-transmission','trademark','open-source-license','open-source-license']);
 assert.equal(fintech.highSeverityCount,3);assert.equal(fintech.requiresCounselReview,true);
 assert.equal(spotIssues({projectId:'p-1',profile:none,dependencies:[{name:'lib-x',license:'GPL-3.0'}],distribution:'distributed-binary'}).issues[0].severity,'high');
 assert.throws(()=>spotIssues({projectId:'p-1',profile:{...none,handlesPersonalData:undefined}}),/answered true or false/);
 assert.throws(()=>spotIssues({projectId:'p-1',profile:{...none,isTotallyLegal:true}}),/Unknown profile flag/);
});

const DAY=86_400_000,start=1_000*DAY;
test('sprints enforce capacity, WIP and flow, and report honest burndown and velocity',()=>{
 const board=new SprintBoard({projectId:'p-1',wipLimit:1});
 assert.throws(()=>board.plan({sprintId:'s-1',startsAt:start,days:5,capacityPoints:10,items:[{itemId:'a',points:8},{itemId:'b',points:5}]}),{code:'OVERCOMMITTED'});
 board.plan({sprintId:'s-1',startsAt:start,days:5,capacityPoints:10,items:[{itemId:'a',points:5},{itemId:'b',points:3}]});
 assert.throws(()=>board.plan({sprintId:'s-2',startsAt:start,days:5,capacityPoints:10,items:[{itemId:'z',points:1}]}),{code:'SPRINT_ACTIVE'});
 assert.throws(()=>board.move({sprintId:'s-1',itemId:'a',state:'DONE',now:start}),{code:'ITEM_TRANSITION'});
 board.move({sprintId:'s-1',itemId:'a',state:'DOING',now:start});
 assert.throws(()=>board.move({sprintId:'s-1',itemId:'b',state:'DOING',now:start}),{code:'WIP_LIMIT'});
 board.move({sprintId:'s-1',itemId:'a',state:'DONE',now:start+DAY+1});
 board.addItem({sprintId:'s-1',itemId:'urgent',points:2,now:start+2*DAY});
 board.move({sprintId:'s-1',itemId:'urgent',state:'DOING',now:start+2*DAY});board.move({sprintId:'s-1',itemId:'urgent',state:'DONE',now:start+3*DAY});
 const burndown=board.burndown({sprintId:'s-1'});
 assert.deepEqual(burndown.map(point=>point.remainingPoints),[10,10,5,3,3,3]);assert.equal(burndown[0].idealPoints,8);assert.equal(burndown[5].idealPoints,0);
 assert.throws(()=>board.close({sprintId:'s-1',now:start+DAY}),{code:'SPRINT_NOT_OVER'});
 const closed=board.close({sprintId:'s-1',now:start+5*DAY});
 assert.equal(closed.items.find(item=>item.itemId==='b').carriedOver,true);
 assert.deepEqual({...board.velocity(),committedDonePoints:[...board.velocity().committedDonePoints]},{sprints:1,committedDonePoints:[5],averagePoints:5});
});
