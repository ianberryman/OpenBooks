package org.openbooks.openbooksapi.core.controller;

import org.openbooks.openbooksapi.core.model.AccountingEntry;
import org.openbooks.openbooksapi.core.model.AccountingEntryDto;
import org.openbooks.openbooksapi.core.model.DoubleEntryAccountingEntry;
import org.openbooks.openbooksapi.core.model.JournalService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class AccountingEntryController {

    @Autowired
    private JournalService<DoubleEntryAccountingEntry> journal;

    @GetMapping("/entries")
    public List<DoubleEntryAccountingEntry> getEntries() {
        return journal.getAccountingEntries();
    }

    @PostMapping("/entries")
    public DoubleEntryAccountingEntry addEntry(@RequestBody DoubleEntryAccountingEntry entry) {
        return journal.commitAccountingEntry(entry);
    }
}
