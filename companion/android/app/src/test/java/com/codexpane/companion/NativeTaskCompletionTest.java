package com.codexpane.companion;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativeTaskCompletionTest {
    @Test public void onlyExplicitGoalCompletionNotTurnOrQueueCompletion() {
        for(String state:new String[]{"idle","running","waiting","completed","failed","paused","blocked","usageLimited","budgetLimited"})
            assertFalse(state,NativeTaskCompletion.completed("active",state));
        assertTrue(NativeTaskCompletion.completed("active","complete"));
    }
    @Test public void historicalAndReplayedCompletionStayQuiet() {
        assertFalse(NativeTaskCompletion.completed("","complete"));
        assertFalse(NativeTaskCompletion.completed("complete","complete"));
        assertFalse(NativeTaskCompletion.completed("unknown","complete"));
    }
    @Test public void resumedGoalCanCompleteAgain() {
        assertFalse(NativeTaskCompletion.completed("complete","active"));
        assertTrue(NativeTaskCompletion.completed("active","complete"));
        assertTrue(NativeTaskCompletion.completed("paused","complete"));
    }
    @Test public void missingOrRuntimeStateIsNotGoalEvidence() {
        for(String state:new String[]{"","null","unknown","idle","completed","running","waiting"})assertFalse(NativeTaskCompletion.known(state));
    }
}
