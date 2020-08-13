package org.openbooks.openbooksapi.core.repository;

import org.openbooks.openbooksapi.core.model.DoubleEntryAccountingEntry;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface DoubleEntryAccountingEntryRepository extends JpaRepository<DoubleEntryAccountingEntry, Long>{}
