package org.openbooks.openbooksapi.core.controller;

import org.openbooks.openbooksapi.core.error.UnbalancedAccountingEntryException;
import org.openbooks.openbooksapi.core.model.DoubleEntryAccountingEntry;
import org.openbooks.openbooksapi.core.model.JournalService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/entries")
public class AccountingEntryController {

    @Autowired
    private JournalService<DoubleEntryAccountingEntry> journal;

    @GetMapping
    public List<DoubleEntryAccountingEntry> getEntries() {
        return journal.getAccountingEntries();
    }

    @PostMapping
    public ResponseEntity<DoubleEntryAccountingEntry> createEntry(@RequestBody DoubleEntryAccountingEntry entry)
            throws UnbalancedAccountingEntryException {
        return ResponseEntity.created(null).body(journal.commitAccountingEntry(entry));
    }

    @PutMapping
    public ResponseEntity<DoubleEntryAccountingEntry> updateEntry(@RequestBody DoubleEntryAccountingEntry entry)
            throws UnbalancedAccountingEntryException {
        return ResponseEntity.ok(journal.updateAccountingEntry(entry));
    }
}
